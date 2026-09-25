/*
 * ========================================
 * CALLER VERIFICATION (shared by inbound + outbound)
 * ========================================
 *
 * 1. "Enter your birth date..."           → keypad, 8 digits (MMDDYYYY)
 * 2. "You entered March 5, 1955. Press 1 if correct, 2 to change."
 *    → DOB gets 2 attempts in total
 * 3. "Say your first name."  → Bandwidth real-time <StartTranscription>
 * 4. "Say your last name."   → Bandwidth real-time <StartTranscription>
 *    (steps 3–4 are TURNED OFF for now → see ENABLE_NAME_STEP)
 * 5. DOB must match a patient EXACTLY.
 *
 * DOB ok   → the direction's onVerified() returns the next BXML
 *            (inbound: queue / ring doctor, outbound: connect doctor)
 * DOB fail → polite message + hangup
 *
 * No recordings are made. No outside AI / API key is needed:
 * transcription runs inside Bandwidth with your existing credentials.
 */

module.exports = function registerVerification(app, ctx) {
    const axios = require("axios");

    const {
        config,
        patients,
        getPatientById,
        getAccessToken,
        xmlEscape,
        sendBxml,
    } = ctx;

    const { NGROK_URL } = config;

    /* ----------------------------------------
     * CONFIG
     * ---------------------------------------- */

    /*
     * NAME STEP ON / OFF
     *
     * false → DOB only: after the DOB is confirmed, the call connects.
     * true  → DOB, then "say your first / last name" (transcribed + logged).
     */
    const ENABLE_NAME_STEP = false;

    const MAX_DOB_ATTEMPTS = 2; // wrong / invalid / unknown DOB entries
    const MAX_CONFIRM_ATTEMPTS = 2; // no answer at "press 1 to confirm"
    const NAME_LISTEN_SECONDS = 5; // how long we listen for each name
    const TRANSCRIPT_SETTLE_MS = 12 * 1000; // wait for transcripts (includes fetch retries)
    const WAIT_PAUSE_SECONDS = 1;
    const SESSION_MAX_AGE_MS = 15 * 60 * 1000;

    const MONTHS = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];

    /* ----------------------------------------
     * STATE
     * ---------------------------------------- */

    const sessions = new Map(); // callId → verification session
    const purposes = {}; // "inbound" | "outbound" → { onVerified, onFailed }

    function registerPurpose(purpose, handlers) {
        purposes[purpose] = handlers;
    }

    /* ----------------------------------------
     * URL / BXML HELPERS
     * ---------------------------------------- */

    function stepUrl(session, step) {
        return (
            `${NGROK_URL}/api/callbacks/voice/verify` +
            `?callId=${encodeURIComponent(session.callId)}` +
            `&step=${encodeURIComponent(step)}`
        );
    }

    function transcriptUrl(session, field) {
        return (
            `${NGROK_URL}/api/callbacks/voice/verify-transcript` +
            `?callId=${encodeURIComponent(session.callId)}` +
            `&field=${encodeURIComponent(field)}` +
            `&attempt=${session.nameAttempts}`
        );
    }

    function transcriptionName(session, field) {
        return `verify-${field}-${session.nameAttempts}`;
    }

    function speak(text) {
        return `<SpeakSentence>${xmlEscape(text)}</SpeakSentence>`;
    }

    function formatDobForSpeech(isoDob) {
        const [year, month, day] = isoDob.split("-").map(Number);

        return `${MONTHS[month - 1]} ${day}, ${year}`;
    }

    /*
     * "03051955" → "1955-03-05" (or null if not a real date)
     */

    function parseDobDigits(digits) {
        if (!/^\d{8}$/.test(digits || "")) return null;

        const month = Number(digits.slice(0, 2));
        const day = Number(digits.slice(2, 4));
        const year = Number(digits.slice(4, 8));
        const currentYear = new Date().getFullYear();

        if (month < 1 || month > 12) return null;
        if (year < 1900 || year > currentYear) return null;

        const daysInMonth = new Date(year, month, 0).getDate();

        if (day < 1 || day > daysInMonth) return null;

        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }

    /* ----------------------------------------
     * PROMPTS (slow, clear, repeated once)
     * ---------------------------------------- */

    /*
     * Credits: Bandwidth bills speech per 100 characters, per sentence.
     * So prompts are short, and a prefix ("One more try.") is merged
     * into the SAME sentence instead of being a separate one.
     */

    const DOB_PROMPT =
        "Enter your birth date: 2-digit month, 2-digit day, 4-digit year.";

    function askDobVerbs(session, prefix) {
        const text = prefix ? `${prefix} ${DOB_PROMPT}` : DOB_PROMPT;

        return (
            `<Gather gatherUrl="${xmlEscape(stepUrl(session, "dob"))}" maxDigits="8" ` +
            `firstDigitTimeout="15" interDigitTimeout="10" repeatCount="2">` +
            speak(text) +
            "</Gather>"
        );
    }

    function confirmDobVerbs(session) {
        return (
            `<Gather gatherUrl="${xmlEscape(stepUrl(session, "dob-confirm"))}" maxDigits="1" ` +
            `firstDigitTimeout="10" repeatCount="2">` +
            speak(
                `You entered ${formatDobForSpeech(session.pendingDob)}. Press 1 if correct, 2 to change.`,
            ) +
            "</Gather>"
        );
    }

    /*
     * Prompt → start real-time transcription of the CALLER's audio only
     * (tracks="inbound", so our own prompts are not transcribed)
     * → listen → stop → next step.
     */

    function listenForNameVerbs(session, field, prompt, nextStep, prefix) {
        const name = transcriptionName(session, field);

        return (
            speak(prefix ? `${prefix} ${prompt}` : prompt) +
            `<StartTranscription name="${xmlEscape(name)}" tracks="inbound" ` +
            `transcriptionEventUrl="${xmlEscape(transcriptUrl(session, field))}" ` +
            `transcriptionEventMethod="POST"/>` +
            `<Pause duration="${NAME_LISTEN_SECONDS}"/>` +
            `<StopTranscription name="${xmlEscape(name)}"/>` +
            `<Redirect redirectUrl="${xmlEscape(stepUrl(session, nextStep))}"/>`
        );
    }

    function askFirstNameVerbs(session, prefix) {
        return listenForNameVerbs(
            session,
            "firstName",
            "Say your first name.",
            "first-done",
            prefix,
        );
    }

    function askLastNameVerbs(session) {
        return listenForNameVerbs(
            session,
            "lastName",
            "Say your last name.",
            "last-done",
        );
    }

    function waitVerbs(session) {
        let verbs = "";

        if (!session.announcedWait) {
            verbs = speak("One moment.");
            session.announcedWait = true;
        }

        return (
            verbs +
            `<Pause duration="${WAIT_PAUSE_SECONDS}"/>` +
            `<Redirect redirectUrl="${xmlEscape(stepUrl(session, "wait"))}"/>`
        );
    }

    /* ----------------------------------------
     * START VERIFICATION
     *
     * options:
     *   purpose:           "inbound" | "outbound"
     *   expectedPatientId: outbound → the patient the doctor called
     *   from, to:          phone numbers
     *   data:              anything the purpose needs later
     *   greeting:          optional sentence before the DOB prompt
     *
     * Returns BXML verbs for the first prompt.
     * ---------------------------------------- */

    function start(callId, options) {
        const session = {
            callId: callId,
            purpose: options.purpose,
            expectedPatientId: options.expectedPatientId || null,
            from: options.from || null,
            to: options.to || null,
            data: options.data || {},
            dobAttempts: 0,
            confirmAttempts: 0,
            nameAttempts: 0,
            pendingDob: null,
            dob: null,
            transcripts: { firstName: [], lastName: [] },
            lastNameDoneAt: null,
            createdAt: Date.now(),
        };

        sessions.set(callId, session);

        console.log(
            "Verification started:",
            callId,
            "| purpose:",
            session.purpose,
            "| expected patient:",
            session.expectedPatientId || "any",
        );

        return askDobVerbs(session, options.greeting || null);
    }

    /*
     * Patients who could be this caller, given the DOB.
     */

    function getCandidates(session, dob) {
        if (session.expectedPatientId) {
            const patient = getPatientById(session.expectedPatientId);

            return patient && patient.dob === dob ? [patient] : [];
        }

        return patients.filter(function (patient) {
            return patient.dob === dob;
        });
    }

    function heardText(session, field) {
        const segments = session.transcripts[field];

        // Last (most complete) segment is what we show in logs / UI.
        return segments.length ? segments[segments.length - 1] : "";
    }

    function allHeardText(session, field) {
        return session.transcripts[field].join(" ");
    }

    /* ----------------------------------------
     * FINISH (verified or failed)
     * ---------------------------------------- */

    function finish(session, res, verified, result) {
        sessions.delete(session.callId);

        const handlers = purposes[session.purpose];

        if (!handlers) {
            console.error(
                "No verification handler for purpose:",
                session.purpose,
            );

            return sendBxml(
                res,
                speak("Sorry, an error occurred. Goodbye.") + "<Hangup/>",
            );
        }

        console.log("=================================");
        console.log(
            "VERIFICATION",
            verified ? "PASSED" : "FAILED",
            "| call:",
            session.callId,
        );
        console.log(JSON.stringify(result, null, 2));
        console.log("=================================");

        const verbs = verified
            ? handlers.onVerified(session, result)
            : handlers.onFailed(session, result);

        sendBxml(res, verbs);
    }

    function fail(session, res, reason) {
        finish(session, res, false, {
            verified: false,
            reason: reason,
            dob: session.dob || session.pendingDob,
            heardFirstName: heardText(session, "firstName"),
            heardLastName: heardText(session, "lastName"),
        });
    }

    /* ----------------------------------------
     * AFTER BOTH NAMES: LOG + CONNECT
     *
     * Names are NOT checked for now. Whatever the caller said
     * is transcribed, logged, and the call is connected.
     * ---------------------------------------- */

    function completeAfterNames(session, res) {
        const heardFirst = allHeardText(session, "firstName");
        const heardLast = allHeardText(session, "lastName");

        // DOB already matched at least one patient.
        const candidates = getCandidates(session, session.dob);
        const patient = candidates[0];

        console.log("=================================");
        console.log("NAME TRANSCRIPT | call:", session.callId);
        console.log(
            "First name said:",
            heardFirst ? JSON.stringify(heardFirst) : "(nothing heard)",
        );
        console.log(
            "Last name said: ",
            heardLast ? JSON.stringify(heardLast) : "(nothing heard)",
        );
        console.log(
            "Patient (by DOB):",
            patient
                ? `${patient.id} ${patient.firstName} ${patient.lastName}`
                : "NONE",
        );

        if (candidates.length > 1) {
            console.warn(
                "More than one patient has this DOB:",
                candidates.map((p) => p.id).join(", "),
                "→ using",
                patient.id,
            );
        }

        console.log("=================================");

        if (!patient) {
            return fail(session, res, "dob_not_found");
        }

        finish(session, res, true, {
            verified: true,
            method: "dob",
            patientId: patient.id,
            dob: session.dob,
            heardFirstName: heardFirst,
            heardLastName: heardLast,
        });
    }

    function beginNameAttempt(session) {
        session.nameAttempts += 1;
        session.transcripts = { firstName: [], lastName: [] };
        session.lastNameDoneAt = null;
        session.announcedWait = false;
    }

    /* ----------------------------------------
     * STEP ROUTE (Gather results / listening windows / wait)
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/verify", function (req, res) {
        const callId = req.query.callId || req.body?.callId;
        const step = req.query.step;
        const session = sessions.get(callId);

        if (!session) {
            console.warn("Verification session not found:", callId, step);

            return sendBxml(res, "<Hangup/>");
        }

        const digits = String(req.body?.digits || "").replace(/\D/g, "");

        switch (step) {
            /*
             * DOB entered
             */
            case "dob": {
                const dob = parseDobDigits(digits);

                if (!dob) {
                    session.dobAttempts += 1;

                    console.log(
                        "Invalid DOB entry:",
                        JSON.stringify(digits),
                        "| attempt:",
                        session.dobAttempts,
                    );

                    if (session.dobAttempts >= MAX_DOB_ATTEMPTS) {
                        return fail(
                            session,
                            res,
                            digits ? "dob_invalid" : "dob_not_entered",
                        );
                    }

                    return sendBxml(
                        res,
                        askDobVerbs(
                            session,
                            digits
                                ? "Invalid date. One more try."
                                : "No date received. One more try.",
                        ),
                    );
                }

                session.pendingDob = dob;
                session.confirmAttempts = 0;

                return sendBxml(res, confirmDobVerbs(session));
            }

            /*
             * DOB read back → 1 correct, 2 re-enter
             */
            case "dob-confirm": {
                if (digits === "1") {
                    const candidates = getCandidates(
                        session,
                        session.pendingDob,
                    );

                    if (!candidates.length) {
                        session.dobAttempts += 1;

                        console.log(
                            "DOB not found:",
                            session.pendingDob,
                            "| attempt:",
                            session.dobAttempts,
                        );

                        if (session.dobAttempts >= MAX_DOB_ATTEMPTS) {
                            return fail(session, res, "dob_not_found");
                        }

                        return sendBxml(
                            res,
                            askDobVerbs(
                                session,
                                "Date not found. One more try.",
                            ),
                        );
                    }

                    session.dob = session.pendingDob;

                    /*
                     * DOB only (name step turned off) → connect now.
                     */
                    if (!ENABLE_NAME_STEP) {
                        const patient = candidates[0];

                        if (candidates.length > 1) {
                            console.warn(
                                "More than one patient has this DOB:",
                                candidates.map((p) => p.id).join(", "),
                                "→ using",
                                patient.id,
                            );
                        }

                        return finish(session, res, true, {
                            verified: true,
                            method: "dob",
                            patientId: patient.id,
                            dob: session.dob,
                            heardFirstName: "",
                            heardLastName: "",
                        });
                    }

                    // Name step (turned off for now):
                    beginNameAttempt(session);

                    return sendBxml(res, askFirstNameVerbs(session));
                }

                if (digits === "2") {
                    // Caller caught their own typo → does not use up a DOB attempt.
                    return sendBxml(
                        res,
                        askDobVerbs(session, "Okay, enter it again."),
                    );
                }

                session.confirmAttempts += 1;

                if (session.confirmAttempts >= MAX_CONFIRM_ATTEMPTS) {
                    return fail(session, res, "dob_not_confirmed");
                }

                return sendBxml(res, confirmDobVerbs(session));
            }

            /*
             * First name listening window finished → ask last name
             */
            case "first-done":
                return sendBxml(res, askLastNameVerbs(session));

            /*
             * Last name listening window finished → log + connect
             * (wait briefly for late transcription events)
             */
            case "last-done":
                session.lastNameDoneAt = Date.now();

                return sendBxml(res, waitVerbs(session));

            case "wait": {
                const haveBoth =
                    session.transcripts.firstName.length > 0 &&
                    session.transcripts.lastName.length > 0;

                const settled =
                    Date.now() - (session.lastNameDoneAt || 0) >
                    TRANSCRIPT_SETTLE_MS;

                const fetching = (session.pendingFetches || 0) > 0;

                if ((haveBoth && !fetching) || settled) {
                    if (!haveBoth) {
                        console.warn(
                            "Transcription incomplete for",
                            callId,
                            "| first:",
                            session.transcripts.firstName.length,
                            "| last:",
                            session.transcripts.lastName.length,
                        );
                    }

                    return completeAfterNames(session, res);
                }

                return sendBxml(res, waitVerbs(session));
            }

            default:
                console.warn("Unknown verification step:", step);

                return sendBxml(res, "<Hangup/>");
        }
    });

    /* ----------------------------------------
     * REAL-TIME TRANSCRIPTION EVENTS
     * ---------------------------------------- */

    /*
     * Bandwidth sends three events per listening window:
     *
     *   realTimeTranscriptionStarted    → ignored
     *   realTimeTranscriptionStopped    → ignored
     *   realTimeTranscriptionAvailable  → contains realTimeTranscription.url
     *                                     → GET that url for the spoken text
     */

    function collectTranscriptText(value, out, parentTrack) {
        if (!value) return out;

        if (Array.isArray(value)) {
            for (const item of value)
                collectTranscriptText(item, out, parentTrack);

            return out;
        }

        if (typeof value !== "object") return out;

        const track = String(value.track || parentTrack || "").toLowerCase();

        // Skip our own prompt audio if the response contains both tracks.
        if (track === "outbound") return out;

        for (const key of ["text", "transcript"]) {
            if (typeof value[key] === "string" && value[key].trim()) {
                out.push(value[key].trim());
            }
        }

        for (const [key, child] of Object.entries(value)) {
            if (child && typeof child === "object") {
                collectTranscriptText(child, out, track || parentTrack);
            }
        }

        return out;
    }

    function sleep(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    async function getJson(url) {
        const accessToken = await getAccessToken();

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
            },
        });

        return response.data;
    }

    /*
     * The transcript is often not ready at the moment the
     * "available" event arrives → Bandwidth answers 404.
     * Retry a few times, then try the call's transcription list.
     */

    const TRANSCRIPT_RETRY_DELAYS_MS = [0, 700, 1200, 2000, 3000];

    async function fetchRealTimeTranscript(url, callUrl, transcriptionId) {
        let lastError = null;

        for (let i = 0; i < TRANSCRIPT_RETRY_DELAYS_MS.length; i++) {
            if (TRANSCRIPT_RETRY_DELAYS_MS[i])
                await sleep(TRANSCRIPT_RETRY_DELAYS_MS[i]);

            try {
                const data = await getJson(url);

                console.log(
                    `Transcript response (try ${i + 1}):`,
                    JSON.stringify(data).slice(0, 1000),
                );

                return uniqueParts(collectTranscriptText(data, []));
            } catch (error) {
                lastError = error;

                const status = error.response?.status;

                console.log(
                    `Transcript not ready (try ${i + 1}): ${status || error.message}`,
                );

                if (status && status !== 404) break; // 401 / 403 etc. → retrying won't help
            }
        }

        /*
         * Fallback: list all transcriptions of this call and pick ours.
         */

        if (callUrl) {
            try {
                const list = await getJson(`${callUrl}/transcriptions`);

                console.log(
                    "Transcription list:",
                    JSON.stringify(list).slice(0, 1000),
                );

                const items = Array.isArray(list)
                    ? list
                    : list?.transcriptions || list?.data || [];

                const ours = items.find(function (item) {
                    return (
                        item?.transcriptionId === transcriptionId ||
                        item?.id === transcriptionId
                    );
                });

                if (ours) {
                    return uniqueParts(collectTranscriptText(ours, []));
                }
            } catch (error) {
                console.log(
                    "Transcription list not available:",
                    error.response?.status || error.message,
                );
            }
        }

        throw lastError || new Error("Transcript not available");
    }

    function uniqueParts(parts) {
        return parts.filter(function (part, index) {
            return parts.indexOf(part) === index;
        });
    }

    /*
     * Which field / attempt an event belongs to.
     * Query string first, transcription name ("verify-firstName-1") as backup.
     */

    function eventTarget(req, event) {
        let field = req.query.field;
        let attempt = req.query.attempt;

        const name = event.realTimeTranscription?.name || "";
        const match = /^verify-(firstName|lastName)-(\d+)$/.exec(name);

        if (match) {
            field = field || match[1];
            attempt = attempt || match[2];
        }

        return { field: field, attempt: attempt };
    }

    app.post(
        "/api/callbacks/voice/verify-transcript",
        async function (req, res) {
            res.sendStatus(200);

            const event = req.body || {};
            const eventType = event.eventType;
            const callId = event.callId || req.query.callId;
            const { field, attempt } = eventTarget(req, event);

            console.log(
                "Transcription event:",
                eventType,
                "|",
                callId,
                "|",
                field,
                "| attempt:",
                attempt,
            );

            if (eventType !== "realTimeTranscriptionAvailable") {
                return; // started / stopped carry no text
            }

            const session = sessions.get(callId);

            if (!session || String(session.nameAttempts) !== String(attempt)) {
                return; // call ended or an older attempt
            }

            if (field !== "firstName" && field !== "lastName") return;

            const url = event.realTimeTranscription?.url;

            if (!url) {
                console.warn(
                    "Transcription available but no url:",
                    JSON.stringify(event),
                );

                return;
            }

            session.pendingFetches = (session.pendingFetches || 0) + 1;

            try {
                const parts = await fetchRealTimeTranscript(url);

                // Session may have moved on while we were fetching.
                if (
                    sessions.get(callId) !== session ||
                    String(session.nameAttempts) !== String(attempt)
                ) {
                    return;
                }

                if (!parts.length) {
                    console.log("Heard", field, "→ (nothing)");

                    return;
                }

                session.transcripts[field].push(parts.join(" "));

                console.log(
                    "Heard",
                    field,
                    "→",
                    JSON.stringify(parts.join(" ")),
                );
            } catch (error) {
                console.error(
                    "Failed to fetch transcript:",
                    error.response?.status || "",
                    JSON.stringify(error.response?.data || error.message),
                );
            } finally {
                session.pendingFetches = Math.max(
                    0,
                    (session.pendingFetches || 1) - 1,
                );
            }
        },
    );

    /* ----------------------------------------
     * DISCONNECT (called by server.js)
     * ---------------------------------------- */

    function handleDisconnect(event) {
        if (!sessions.has(event.callId)) return false;

        sessions.delete(event.callId);

        console.log("Caller hung up during verification:", event.callId);

        return true;
    }

    const sweeper = setInterval(function () {
        const now = Date.now();

        for (const [callId, session] of sessions.entries()) {
            if (now - session.createdAt > SESSION_MAX_AGE_MS)
                sessions.delete(callId);
        }
    }, 60 * 1000);

    if (sweeper.unref) sweeper.unref();

    console.log(
        "Verification routes registered:",
        ENABLE_NAME_STEP
            ? "DOB + name transcription"
            : "DOB only (name step off)",
    );

    return {
        start,
        registerPurpose,
        handleDisconnect,
    };
};
