/*
 * ========================================
 * INBOUND (patient calls doctor)
 * ========================================
 *
 * Patient calls the facility number
 *   ↓
 * Caller verification (verification.server.js):
 *   DOB on keypad → read back, press 1 → say first name → say last name
 *   → DOB exact + names fuzzy → patient identified
 *   ↓
 * Verified patient → assigned doctor ONLY (no fallback doctor)
 *   ↓
 * Doctor offline      → "not available, try again later" → hangup
 * Doctor free         → doctor's browser rings,
 *                       patient hears "please hold while we connect you"
 * Doctor busy/ringing → patient joins the doctor's queue,
 *                       doctor sees "N patients waiting",
 *                       patient hears position + "stay on the line
 *                       or hang up and try again later"
 *   ↓
 * Doctor becomes free → next patient in the queue rings the doctor
 *   ↓
 * Doctor accepts      → PSTN call redirected → <Connect><Endpoint>
 *   ↓
 * Either side hangs up → call closed, doctor freed, next patient rings
 */

module.exports = function registerInbound(app, ctx) {
    const {
        config,
        brtcEndpointStatus,
        doctorEndpointMap,
        patientDoctorMap,
        redirectVoiceCall,
        endVoiceCallSafe,
        verification,
        isDoctorOnline,
        getDoctorCallState,
        setDoctorBusy,
        markDoctorFree,
        sendDoctorEvent,
        xmlEscape,
        sendBxml,
    } = ctx;

    const { NGROK_URL, AFTER_CALL_DISPATCH_DELAY_MS, DISCONNECT_DISPATCH_DELAY_MS } = config;

    /* ----------------------------------------
     * CONFIG
     * ---------------------------------------- */

    const RING_TIMEOUT_MS = 30 * 1000; // how long the doctor's browser rings
    const QUEUE_HOLD_PAUSE_SECONDS = 20; // pause between queue announcements
    const OFFER_HOLD_PAUSE_SECONDS = 10; // pause while the doctor is being rung
    const MAX_QUEUE_SIZE = 5; // callers waiting per doctor
    const MAX_QUEUE_WAIT_MS = 10 * 60 * 1000; // max time a patient waits
    const STALE_CALL_MS = 90 * 1000; // no hold request this long → caller gone
    const OFFLINE_GRACE_MS = 30 * 1000; // doctor offline this long → release queue
    const SWEEP_INTERVAL_MS = 10 * 1000;

    // Short on purpose: Bandwidth bills speech per 100 characters.
    const MESSAGES = {
        unknown: "We can't find your record. Please call the front desk.",
        offline: "Your doctor is unavailable. Please call again later.",
        full: "Too many callers waiting. Please call again later.",
        declined: "Your doctor can't take your call. Please call again later.",
        missed: "Your doctor didn't answer. Please call again later.",
        timeout: "Your doctor is still busy. Please call again later.",
        connecting: "Thank you. Please hold for your doctor.",
        unverified: "We couldn't verify you. Please call the front desk.",
    };

    /* ----------------------------------------
     * INBOUND STATE
     * ---------------------------------------- */

    /*
     * inboundDoctors: doctorId → {
     *   offeredCallId: PSTN call currently ringing the doctor
     *   queue:         [pstnCallId, ...] FIFO
     *   offlineSince:  timestamp
     * }
     *
     * calls: pstnCallId → session
     *   status: "QUEUED" | "OFFERED" | "CONNECTING" | "CONNECTED"
     *
     * The doctor's busy state (busyReason / activeCallId) lives in server.js.
     */

    const inboundDoctors = new Map();
    const calls = new Map();

    /* ----------------------------------------
     * HELPERS
     * ---------------------------------------- */

    function getInboundDoctor(doctorId) {
        if (!inboundDoctors.has(doctorId)) {
            inboundDoctors.set(doctorId, {
                offeredCallId: null,
                queue: [],
                offlineSince: null,
            });
        }

        return inboundDoctors.get(doctorId);
    }

    function isDoctorFree(doctorId) {
        const state = getDoctorCallState(doctorId);

        return !state.busyReason && !state.activeCallId && !getInboundDoctor(doctorId).offeredCallId;
    }

    function queuePosition(session) {
        const index = getInboundDoctor(session.doctorId).queue.indexOf(session.pstnCallId);

        return index === -1 ? 1 : index + 1;
    }

    function holdUrl(pstnCallId) {
        return `${NGROK_URL}/api/callbacks/voice/inbound-hold?pstnCallId=${encodeURIComponent(pstnCallId)}`;
    }

    function unavailableVerbs(reason) {
        const message = MESSAGES[reason] || MESSAGES.offline;

        return `<SpeakSentence>${xmlEscape(message)}</SpeakSentence><Hangup/>`;
    }

    /*
     * Hold loop: message → pause → redirect back to the hold URL.
     * Accepting the call interrupts this loop with a redirect.
     */

    function holdVerbs(session) {
        session.lastSeen = Date.now();

        let speech = null;
        let pause;

        if (session.status === "OFFERED") {
            if (!session.announcedOffer) {
                speech = MESSAGES.connecting;
                session.announcedOffer = true;
            }

            pause = OFFER_HOLD_PAUSE_SECONDS;
        } else {
            const position = queuePosition(session);

            // Speak only when the position changes → far fewer credits.
            if (!session.announcedQueue) {
                speech = `Your doctor is busy. You are number ${position} in line. Please hold or call later.`;
            } else if (position !== session.announcedPosition) {
                speech = `You are now number ${position} in line.`;
            }

            session.announcedQueue = true;
            session.announcedPosition = position;
            pause = QUEUE_HOLD_PAUSE_SECONDS;
        }

        return (
            (speech ? `<SpeakSentence>${xmlEscape(speech)}</SpeakSentence>` : "") +
            `<Pause duration="${pause}"/>` +
            `<Redirect redirectUrl="${xmlEscape(holdUrl(session.pstnCallId))}"/>`
        );
    }

    /*
     * Send the doctor the current waiting list.
     */

    function broadcastQueue(doctorId) {
        if (!doctorId) return;

        const doctor = getInboundDoctor(doctorId);
        const now = Date.now();

        const waiting = doctor.queue
            .map(function (pstnCallId, index) {
                const session = calls.get(pstnCallId);

                if (!session) return null;

                return {
                    pstnCallId: pstnCallId,
                    patientId: session.patientId,
                    from: session.from,
                    position: index + 1,
                    waitingSeconds: Math.round((now - session.createdAt) / 1000),
                };
            })
            .filter(Boolean);

        sendDoctorEvent(doctorId, {
            type: "inboundQueueUpdated",
            doctorId: doctorId,
            count: waiting.length,
            waiting: waiting,
        });
    }

    function redirectToUnavailable(session, reason) {
        const url =
            `${NGROK_URL}/api/callbacks/voice/inbound-unavailable` +
            `?reason=${encodeURIComponent(reason)}`;

        redirectVoiceCall(session.pstnCallId, url).catch(function (error) {
            console.error(
                "Failed to redirect caller to unavailable message:",
                session.pstnCallId,
                error.response?.data || error.message,
            );
        });
    }

    function endOffer(session) {
        clearTimeout(session.ringTimer);
        session.ringTimer = null;

        const doctor = getInboundDoctor(session.doctorId);

        if (doctor.offeredCallId === session.pstnCallId) {
            doctor.offeredCallId = null;
        }
    }

    function requeueFront(session) {
        session.status = "QUEUED";
        session.announcedQueue = false;

        const doctor = getInboundDoctor(session.doctorId);

        if (!doctor.queue.includes(session.pstnCallId)) {
            doctor.queue.unshift(session.pstnCallId);
        }
    }

    function removeCall(session) {
        calls.delete(session.pstnCallId);

        const doctor = getInboundDoctor(session.doctorId);

        doctor.queue = doctor.queue.filter(function (id) {
            return id !== session.pstnCallId;
        });

        endOffer(session);
    }

    /* ----------------------------------------
     * RING THE DOCTOR
     * ---------------------------------------- */

    function offerToDoctor(session) {
        const doctor = getInboundDoctor(session.doctorId);
        const endpointId = doctorEndpointMap.get(session.doctorId);

        session.status = "OFFERED";
        session.endpointId = endpointId;
        session.announcedOffer = false;
        doctor.offeredCallId = session.pstnCallId;

        const sent = sendDoctorEvent(session.doctorId, {
            type: "incomingPstnCall",
            pstnCallId: session.pstnCallId,
            doctorId: session.doctorId,
            endpointId: endpointId,
            patientId: session.patientId,
            from: session.from,
            to: session.to,
            verification: session.verification,
            waitedSeconds: Math.round((Date.now() - session.createdAt) / 1000),
        });

        if (!sent) {
            endOffer(session);
            requeueFront(session);

            return false;
        }

        session.ringTimer = setTimeout(function () {
            onOfferMissed(session.pstnCallId);
        }, RING_TIMEOUT_MS);

        console.log("Ringing doctor:", session.doctorId, "| PSTN call:", session.pstnCallId);

        return true;
    }

    function onOfferMissed(pstnCallId) {
        const session = calls.get(pstnCallId);

        if (!session || session.status !== "OFFERED") return;

        console.log("Doctor did not answer in time:", session.doctorId, pstnCallId);

        sendDoctorEvent(session.doctorId, {
            type: "incomingPstnCallCancelled",
            pstnCallId: pstnCallId,
            doctorId: session.doctorId,
            reason: "missed",
        });

        redirectToUnavailable(session, "missed");
        removeCall(session);
        broadcastQueue(session.doctorId);

        setTimeout(function () {
            dispatchNext(session.doctorId);
        }, AFTER_CALL_DISPATCH_DELAY_MS);
    }

    /* ----------------------------------------
     * NEXT PATIENT IN QUEUE
     * (also called by server.js when the doctor becomes free)
     * ---------------------------------------- */

    function dispatchNext(doctorId) {
        const doctor = getInboundDoctor(doctorId);

        if (!isDoctorFree(doctorId) || !isDoctorOnline(doctorId)) return;

        while (doctor.queue.length) {
            const pstnCallId = doctor.queue.shift();
            const session = calls.get(pstnCallId);

            if (!session) continue;

            if (Date.now() - session.lastSeen > STALE_CALL_MS) {
                console.log("Dropping stale queued call:", pstnCallId);

                calls.delete(pstnCallId);

                continue;
            }

            console.log("Next patient in queue for", doctorId, "→", pstnCallId);

            offerToDoctor(session); // puts itself back at the front if SSE failed

            break;
        }

        broadcastQueue(doctorId);
    }

    /* ----------------------------------------
     * CALLER GONE (hung up / ended)
     * ---------------------------------------- */

    function handleCallGone(pstnCallId, options) {
        const session = calls.get(pstnCallId);

        if (!session) return false;

        const notifyDoctor = !options || options.notifyDoctor !== false;
        const previousStatus = session.status;
        const doctorState = getDoctorCallState(session.doctorId);

        removeCall(session);

        console.log("Inbound caller gone:", pstnCallId, "| was:", previousStatus);

        if (previousStatus === "OFFERED") {
            if (notifyDoctor) {
                sendDoctorEvent(session.doctorId, {
                    type: "incomingPstnCallEnded",
                    pstnCallId: pstnCallId,
                    doctorId: session.doctorId,
                });
            }

            setTimeout(function () {
                dispatchNext(session.doctorId);
            }, AFTER_CALL_DISPATCH_DELAY_MS);
        }

        if (
            (previousStatus === "CONNECTING" || previousStatus === "CONNECTED") &&
            doctorState.activeCallId === pstnCallId
        ) {
            if (notifyDoctor) {
                sendDoctorEvent(session.doctorId, {
                    type: "incomingPstnCallEnded",
                    pstnCallId: pstnCallId,
                    doctorId: session.doctorId,
                });
            }

            markDoctorFree(session.doctorId, DISCONNECT_DISPATCH_DELAY_MS);
        }

        broadcastQueue(session.doctorId);

        return true;
    }

    /* ----------------------------------------
     * DISCONNECT (called by server.js)
     * Returns true when the call was an inbound call.
     * ---------------------------------------- */

    function handleDisconnect(event) {
        return handleCallGone(event.callId);
    }

    /*
     * Browser says the doctor is idle but the phone leg is still up.
     * (called by server.js /api/doctor/idle)
     */

    async function endActiveCall(pstnCallId) {
        const session = calls.get(pstnCallId);

        if (!session) return;

        await endVoiceCallSafe(pstnCallId);

        removeCall(session);
        broadcastQueue(session.doctorId);
    }

    /* ----------------------------------------
     * INBOUND CALL INITIATED
     * (Voice application "Call Initiated" URL)
     *
     * Every caller is verified first.
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/initiate", function (req, res) {
        const callId = req.body?.callId;
        const from = req.body?.from;
        const to = req.body?.to;

        console.log("=================================");
        console.log("Inbound call:", callId, "| from:", from, "| to:", to);
        console.log("=================================");

        if (!callId) {
            return sendBxml(res, "<Hangup/>");
        }

        sendBxml(
            res,
            verification.start(callId, {
                purpose: "inbound",
                from: from,
                to: to,
                greeting: "Thanks for calling.",
            }),
        );
    });

    /* ----------------------------------------
     * AFTER VERIFICATION
     * ---------------------------------------- */

    verification.registerPurpose("inbound", {
        onVerified: function (verifySession, result) {
            return routeVerifiedCall({
                callId: verifySession.callId,
                from: verifySession.from,
                to: verifySession.to,
                patientId: result.patientId,
                verification: {
                    verified: true,
                    method: result.method,
                    heardName: `${result.heardFirstName} ${result.heardLastName}`.trim(),
                },
            });
        },

        onFailed: function (verifySession, result) {
            console.log("Inbound caller NOT verified:", verifySession.callId, "| reason:", result.reason);

            return unavailableVerbs("unverified");
        },
    });

    /*
     * Verified patient → assigned doctor (ring now, or queue).
     * Returns BXML verbs.
     */

    function routeVerifiedCall(info) {
        const { callId, from, to, patientId } = info;
        const doctorId = patientDoctorMap.get(patientId) || null;

        console.log("Verified patient:", patientId, "| Assigned doctor:", doctorId || "NONE");

        if (!doctorId) {
            return unavailableVerbs("unknown");
        }

        if (!isDoctorOnline(doctorId)) {
            console.log("Assigned doctor offline:", doctorId);

            return unavailableVerbs("offline");
        }

        const doctor = getInboundDoctor(doctorId);

        if (doctor.queue.length >= MAX_QUEUE_SIZE) {
            console.log("Queue full for doctor:", doctorId);

            return unavailableVerbs("full");
        }

        const session = {
            pstnCallId: callId,
            patientId: patientId,
            doctorId: doctorId,
            from: from,
            to: to,
            verification: info.verification,
            status: "QUEUED",
            endpointId: null,
            ringTimer: null,
            announcedOffer: false,
            announcedQueue: false,
            createdAt: Date.now(),
            lastSeen: Date.now(),
        };

        calls.set(callId, session);

        if (isDoctorFree(doctorId) && doctor.queue.length === 0) {
            offerToDoctor(session);
        } else {
            doctor.queue.push(callId);

            console.log(
                "Doctor busy, patient queued:",
                doctorId,
                "| position:",
                doctor.queue.length,
                "| reason:",
                getDoctorCallState(doctorId).busyReason || (doctor.offeredCallId ? "ringing" : "in call"),
            );
        }

        broadcastQueue(doctorId);

        return holdVerbs(session);
    }

    /* ----------------------------------------
     * HOLD LOOP
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/inbound-hold", function (req, res) {
        const session = calls.get(req.query.pstnCallId);

        if (!session) {
            return sendBxml(res, "<Hangup/>");
        }

        if (session.status === "QUEUED" && Date.now() - session.createdAt > MAX_QUEUE_WAIT_MS) {
            console.log("Max queue wait reached:", session.pstnCallId);

            removeCall(session);
            broadcastQueue(session.doctorId);

            return sendBxml(res, unavailableVerbs("timeout"));
        }

        if (session.status === "QUEUED" || session.status === "OFFERED") {
            return sendBxml(res, holdVerbs(session));
        }

        // CONNECTING: the redirect to the doctor is already in flight.
        session.lastSeen = Date.now();

        sendBxml(
            res,
            `<Pause duration="5"/><Redirect redirectUrl="${xmlEscape(holdUrl(session.pstnCallId))}"/>`,
        );
    });

    /* ----------------------------------------
     * UNAVAILABLE MESSAGE → HANGUP
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/inbound-unavailable", function (req, res) {
        sendBxml(res, unavailableVerbs(req.query.reason));
    });

    /* ----------------------------------------
     * DOCTOR ACCEPTS
     * ---------------------------------------- */

    app.post("/api/calls/inbound/accept", async function (req, res) {
        const { pstnCallId, doctorId, endpointId } = req.body || {};

        console.log("Doctor accept:", doctorId, "| PSTN call:", pstnCallId);

        if (!pstnCallId || !doctorId || !endpointId) {
            return res.status(400).json({
                success: false,
                message: "pstnCallId, doctorId and endpointId are required",
            });
        }

        const session = calls.get(pstnCallId);

        if (!session || session.doctorId !== doctorId) {
            return res.status(404).json({
                success: false,
                message: "Inbound call not found for this doctor (caller may have hung up)",
            });
        }

        if (session.status !== "OFFERED") {
            return res.status(409).json({
                success: false,
                message: `Call is ${session.status.toLowerCase()}, not ringing`,
            });
        }

        const endpointStatus = brtcEndpointStatus.get(endpointId);

        if (
            doctorEndpointMap.get(doctorId) !== endpointId ||
            !endpointStatus ||
            endpointStatus.eligible !== true
        ) {
            endOffer(session);
            requeueFront(session);
            broadcastQueue(doctorId);

            return res.status(409).json({
                success: false,
                message: "Doctor BRTC endpoint is not eligible. Please log in again.",
            });
        }

        endOffer(session);

        session.status = "CONNECTING";
        session.endpointId = endpointId;

        setDoctorBusy(doctorId, "inbound", pstnCallId);

        const winnerUrl =
            `${NGROK_URL}/api/callbacks/voice/inbound-winner` +
            `?pstnCallId=${encodeURIComponent(pstnCallId)}` +
            `&endpointId=${encodeURIComponent(endpointId)}`;

        try {
            await redirectVoiceCall(pstnCallId, winnerUrl);

            session.status = "CONNECTED";

            console.log("PSTN call redirected to doctor:", doctorId, pstnCallId);

            res.json({
                success: true,
                pstnCallId: pstnCallId,
                doctorId: doctorId,
                endpointId: endpointId,
                patientId: session.patientId,
                from: session.from,
            });
        } catch (error) {
            console.error("Failed to redirect PSTN call:", error.response?.data || error.message);

            removeCall(session);
            markDoctorFree(doctorId, AFTER_CALL_DISPATCH_DELAY_MS);
            broadcastQueue(doctorId);

            res.status(502).json({
                success: false,
                message: "Failed to connect call to doctor (caller may have hung up)",
                error: error.response?.data || error.message,
            });
        }
    });

    /* ----------------------------------------
     * CONNECT PSTN → DOCTOR ENDPOINT
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/inbound-winner", function (req, res) {
        const { pstnCallId, endpointId } = req.query;
        const session = calls.get(pstnCallId);

        if (
            !session ||
            session.endpointId !== endpointId ||
            (session.status !== "CONNECTING" && session.status !== "CONNECTED")
        ) {
            console.error("Winner callback rejected:", pstnCallId, endpointId);

            return sendBxml(res, "<Hangup/>");
        }

        console.log("Connecting PSTN", pstnCallId, "→ endpoint", endpointId);

        sendBxml(res, `<Connect><Endpoint>${xmlEscape(endpointId)}</Endpoint></Connect>`);
    });

    /* ----------------------------------------
     * DOCTOR DECLINES
     * ---------------------------------------- */

    app.post("/api/calls/inbound/decline", function (req, res) {
        const { pstnCallId, doctorId } = req.body || {};
        const session = calls.get(pstnCallId);

        if (!session || session.doctorId !== doctorId) {
            return res.status(404).json({ success: false, message: "Inbound call not found" });
        }

        if (session.status !== "OFFERED") {
            return res.status(409).json({ success: false, message: "Call is not ringing" });
        }

        console.log("Doctor declined:", doctorId, pstnCallId);

        redirectToUnavailable(session, "declined");
        removeCall(session);
        broadcastQueue(doctorId);

        setTimeout(function () {
            dispatchNext(doctorId);
        }, AFTER_CALL_DISPATCH_DELAY_MS);

        res.json({ success: true, pstnCallId: pstnCallId, doctorId: doctorId });
    });

    /* ----------------------------------------
     * BROWSER WAS BUSY WHEN THE CALL RANG
     * → patient goes back to the front of the queue
     * ---------------------------------------- */

    app.post("/api/calls/inbound/busy", function (req, res) {
        const { pstnCallId, doctorId } = req.body || {};

        if (!doctorId) {
            return res.status(400).json({ success: false, message: "doctorId is required" });
        }

        const state = getDoctorCallState(doctorId);

        if (!state.busyReason) {
            setDoctorBusy(doctorId, "browser", null);
        }

        const session = calls.get(pstnCallId);

        if (session && session.doctorId === doctorId && session.status === "OFFERED") {
            endOffer(session);
            requeueFront(session);
            broadcastQueue(doctorId);

            console.log("Doctor browser busy, call returned to queue:", pstnCallId);
        }

        res.json({ success: true });
    });

    /* ----------------------------------------
     * DOCTOR ENDS INBOUND CALL
     * ---------------------------------------- */

    app.post("/api/calls/inbound/end", async function (req, res) {
        const pstnCallId = req.body?.pstnCallId;

        if (!pstnCallId) {
            return res.status(400).json({ success: false, message: "pstnCallId is required" });
        }

        await endVoiceCallSafe(pstnCallId);

        // The browser is already cleaning up, so don't send it an "ended" event.
        handleCallGone(pstnCallId, { notifyDoctor: false });

        res.json({ success: true, pstnCallId: pstnCallId });
    });

    /* ----------------------------------------
     * QUEUE STATUS (debugging)
     * ---------------------------------------- */

    app.get("/api/inbound/queue", function (req, res) {
        const result = {};

        for (const [doctorId, doctor] of inboundDoctors.entries()) {
            const state = getDoctorCallState(doctorId);

            result[doctorId] = {
                online: isDoctorOnline(doctorId),
                busyReason: state.busyReason,
                activeCallId: state.activeCallId,
                offeredCallId: doctor.offeredCallId,
                queue: doctor.queue.map(function (id) {
                    const session = calls.get(id);

                    return session
                        ? { pstnCallId: id, patientId: session.patientId, from: session.from }
                        : { pstnCallId: id };
                }),
            };
        }

        res.json({ success: true, doctors: result });
    });

    /* ----------------------------------------
     * SWEEPER
     * - removes callers who silently disappeared
     * - releases the queue if the doctor goes offline
     * - catches up dispatch if something was missed
     * ---------------------------------------- */

    const sweeper = setInterval(function () {
        const now = Date.now();

        for (const session of Array.from(calls.values())) {
            if (
                (session.status === "QUEUED" || session.status === "OFFERED") &&
                now - session.lastSeen > STALE_CALL_MS
            ) {
                console.log("Stale inbound call removed:", session.pstnCallId);

                handleCallGone(session.pstnCallId);
            }
        }

        for (const [doctorId, doctor] of inboundDoctors.entries()) {
            const hasWaiting = doctor.queue.length > 0 || Boolean(doctor.offeredCallId);

            if (!hasWaiting) {
                doctor.offlineSince = null;

                continue;
            }

            if (isDoctorOnline(doctorId)) {
                doctor.offlineSince = null;

                if (isDoctorFree(doctorId)) dispatchNext(doctorId);

                continue;
            }

            doctor.offlineSince = doctor.offlineSince || now;

            if (now - doctor.offlineSince < OFFLINE_GRACE_MS) continue;

            console.log("Doctor offline, releasing queue:", doctorId);

            const waitingIds = doctor.queue.concat(doctor.offeredCallId || []);

            for (const pstnCallId of waitingIds) {
                const session = calls.get(pstnCallId);

                if (!session) continue;

                redirectToUnavailable(session, "offline");
                removeCall(session);
            }

            doctor.queue = [];
            doctor.offlineSince = null;

            broadcastQueue(doctorId);
        }
    }, SWEEP_INTERVAL_MS);

    if (sweeper.unref) sweeper.unref();

    console.log("Inbound routes registered.");

    return {
        dispatchNext,
        broadcastQueue,
        handleDisconnect,
        endActiveCall,
    };
};