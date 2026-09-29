/*
 * ========================================
 * INBOUND (patient calls doctor)
 * ========================================
 *
 * Patient calls the facility number
 *   ↓
 * Identify patient → TWO assigned doctors: primary + secondary
 *   ↓
 * Both offline         → "not available, try again later" → hangup
 * Primary free         → primary's browser rings,
 *                        patient hears "please hold while we connect you"
 * Primary busy/offline,
 * secondary free       → secondary's browser rings instead
 * Both busy/ringing     → patient joins the SHARED queue for this doctor
 *                        pair, either doctor's dashboard shows
 *                        "N patients waiting", patient hears position +
 *                        "stay on the line or hang up and try again later"
 *                        — and any doctor in the pair who is currently
 *                        MID-CALL gets a "patient waiting" notification
 *   ↓
 * Either doctor becomes free → next patient in the pair's shared queue
 *                        rings that doctor
 *   ↓
 * Doctor accepts        → PSTN call redirected → <Connect><Endpoint>
 *   ↓
 * Doctor MISSES the ring (timeout) or DECLINES →
 *     - if the other allocated doctor hasn't been tried yet and is
 *       free/online → speak "Your call is being forwarded to the next
 *       doctor" → ring that doctor instead
 *     - if that second doctor ALSO misses/declines → the caller is
 *       offered a voicemail choice (press 1 to record, press 2 to keep
 *       holding), Bandwidth records their message (<Record>), and once
 *       the recording finishes, BOTH doctors in the pair are notified
 *       with a link to play it back.
 *   ↓
 * Either side hangs up  → call closed, doctor freed, next patient in
 *                        that doctor's queue(s) rings
 *
 * >>> CHANGED IN THIS VERSION
 * 1. DECLINE and a missed ring TIMEOUT now behave identically again: both
 *    try forwarding to the other allocated doctor first, and only offer
 *    the voicemail choice once both doctors have been tried. (An earlier
 *    iteration made Decline hang up immediately instead of forwarding —
 *    that was reverted at the person's request, restoring the original
 *    forward-then-voicemail behavior for both triggers.)
 * 2. Once BOTH allocated doctors have been tried for a ring timeout (or
 *    found offline/busy at initial routing time), the caller is no longer
 *    placed in the shared hold queue at all. Instead they are offered a
 *    voicemail choice (press 1 to record, press 2 to keep holding).
 *    Bandwidth records their message, and — once the recordingAvailableUrl
 *    callback fires — both doctors in the pair get a "patientVoicemail"
 *    notification with a link to play it back (proxied through our own
 *    server, since Bandwidth's mediaUrl needs account credentials the
 *    browser doesn't have).
 *    NOTE: the shared queue itself still exists and is still used for
 *    the ORIGINAL "both doctors currently busy/offline at the moment the
 *    call comes in" case (see /api/callbacks/voice/initiate) and for the
 *    "doctor's browser was busy when rung" case (see
 *    /api/calls/inbound/busy) — only the *forwarding fallback* (missed
 *    ring on the second doctor) skips the queue and offers voicemail
 *    instead.
 * 3. Any doctor in a pair who is genuinely ON AN ACTIVE CALL right now
 *    gets a lightweight "patientWaitingNotification" the moment a new
 *    caller lands in the shared queue at initial routing time — separate
 *    from the normal queue-count broadcast, so a busy doctor knows
 *    someone is trying to reach them without it looking like an
 *    incoming-call ring.
 */

const axios = require("axios");

module.exports = function registerInbound(app, ctx) {
    const {
        config,
        brtcEndpointStatus,
        doctorEndpointMap,
        patientDoctorMap,
        redirectVoiceCall,
        endVoiceCallSafe,
        getPatientIdFromPhone,
        isDoctorOnline,
        getDoctorCallState,
        setDoctorBusy,
        markDoctorFree,
        sendDoctorEvent,
        xmlEscape,
        sendBxml,
    } = ctx;

    const {
        NGROK_URL,
        AFTER_CALL_DISPATCH_DELAY_MS,
        DISCONNECT_DISPATCH_DELAY_MS,
        // >>> ADDED: needed to fetch a completed recording's audio bytes
        // from Bandwidth (mediaUrl requires Basic Auth — see the proxy
        // route near the bottom of this file). Falls back to process.env
        // if your config object doesn't already carry these — adjust to
        // match wherever you already store Bandwidth credentials elsewhere
        // in server.js.
        BANDWIDTH_USERNAME: CFG_BANDWIDTH_USERNAME,
        BANDWIDTH_PASSWORD: CFG_BANDWIDTH_PASSWORD,
    } = config;

    const BANDWIDTH_USERNAME = CFG_BANDWIDTH_USERNAME || process.env.BANDWIDTH_USERNAME;
    const BANDWIDTH_PASSWORD = CFG_BANDWIDTH_PASSWORD || process.env.BANDWIDTH_PASSWORD;

    /* ----------------------------------------
     * CONFIG
     * ---------------------------------------- */

    const RING_TIMEOUT_MS = 30 * 1000; // how long a doctor's browser rings
    const QUEUE_HOLD_PAUSE_SECONDS = 20; // pause between queue announcements
    const OFFER_HOLD_PAUSE_SECONDS = 10; // pause while a doctor is being rung
    const MAX_QUEUE_SIZE = 5; // callers waiting per doctor PAIR
    const MAX_QUEUE_WAIT_MS = 10 * 60 * 1000; // max time a patient waits
    const STALE_CALL_MS = 90 * 1000; // no hold request this long → caller gone
    const OFFLINE_GRACE_MS = 30 * 1000; // both doctors offline this long → release queue
    const SWEEP_INTERVAL_MS = 10 * 1000;
    // >>> REMOVED: RETRY_COOLDOWN_MS used to block dispatchNext() from
    // re-offering a session for 20s after ANY requeueFront() call. It was
    // written for an older design where a decline/missed ring went
    // straight back into the queue, to stop the 10s sweeper instantly
    // re-ringing a doctor who'd just declined. In the current design,
    // decline/miss no longer requeue directly — they only reach the queue
    // via the voicemail-choice "keep holding" path, which is the
    // patient's first real entry into the wait queue, not a rapid retry.
    // The cooldown was incorrectly also blocking THAT case, delaying a
    // dispatch by up to 20s even when a doctor was already free the
    // moment the patient chose to keep holding.

    // only attend calls during working hours (default 9 AM–6 PM).
    //   WORKING_HOURS_START_HOUR=9   WORKING_HOURS_END_HOUR=18
    //   WORKING_HOURS_TIMEZONE=America/New_York   (optional; IANA name)
    const WORKING_HOURS_START_HOUR = Number.isFinite(parseInt(process.env.WORKING_HOURS_START_HOUR, 10))
        ? parseInt(process.env.WORKING_HOURS_START_HOUR, 10)
        : 9; // 9 AM
    const WORKING_HOURS_END_HOUR = Number.isFinite(parseInt(process.env.WORKING_HOURS_END_HOUR, 10))
        ? parseInt(process.env.WORKING_HOURS_END_HOUR, 10)
        : 18; // 6 PM
    const WORKING_HOURS_TIMEZONE = process.env.WORKING_HOURS_TIMEZONE || null;

    // >>> ADDED: voicemail recording config. Only one recording path exists
    // now — reached via the IVR choice below — so there is a single
    // duration constant.
    const VOICEMAIL_FILE_FORMAT = "mp3";

    // >>> ADDED: patient-initiated voicemail via the IVR choice (press 1
    // after both doctors have failed). Per requirement this is capped at
    // 30 seconds.
    const QUEUE_OPT_IN_VOICEMAIL_MAX_DURATION_SECONDS = 30;

    const MESSAGES = {
        unknown:
            "We could not match this phone number to a patient. Please call back from your registered phone number.",
        offline: "Your doctor is not available right now. Please hang up and try again later.",
        full: "Your doctor has too many callers waiting right now. Please hang up and try again later.",
        timeout: "Your doctor is still unavailable. Please hang up and try again later.",
        connecting: "Please hold while we connect you to your doctor.",
        secondaryForward: "Your call is being forwarded to the next doctor.",
        outsideWorkingHours: "Please call back during our regular working hours.",
        // spoken when a QUEUED session (already tried at least once) is
        // automatically re-offered to a doctor after the retry cooldown.
        retryFromQueue: "Thank you for holding. Connecting you to your doctor now.",
        // >>> ADDED: spoken right before the caller is dropped into the
        // voicemail flow, once both allocated doctors have been tried via
        // ring timeout (or found offline/busy at initial routing) and
        // neither could take the call. (A doctor clicking Decline is a
        // separate, simpler path — see the decline route below — and never
        // reaches this voicemail flow.)
        voicemailThanks: "Thank you, your message has been recorded. Goodbye.",
        // >>> ADDED: spoken exactly once, at the moment BOTH allocated
        // doctors have failed via ring timeout or were found
        // offline/busy. This is where the IVR choice belongs — NOT during
        // the regular "doctor is currently busy" queue-wait loop, which
        // stays a plain hold with no keypad prompt.
        voicemailChoicePrompt:
            "Neither of your doctors was able to take your call. To leave a voicemail message, press 1. " +
            "To continue holding until one of them becomes available, press 2.",
        voicemailRecordPrompt: "Please leave your message after the tone.",
        // spoken right before secondaryForward, whenever a specific doctor
        // couldn't be reached — covers every trigger the forwarding logic
        // can hit: a real decline, a ring timeout, being offline, or being
        // busy on another call.
        reason: {
            declined: "Your doctor is unable to take your call right now.",
            missed: "Your doctor did not answer your call.",
            offline: "Your doctor is currently offline.",
            busy: "Your doctor is currently on another call.",
        },
    };

    /* ----------------------------------------
     * WORKING HOURS
     * ---------------------------------------- */

    /*
     * Returns the current hour (0–23). Uses WORKING_HOURS_TIMEZONE if set
     * (via Intl, no extra dependency needed); otherwise falls back to the
     * server process's own local time.
     */
    function getCurrentHour(date) {
        const now = date || new Date();

        if (!WORKING_HOURS_TIMEZONE) {
            return now.getHours();
        }

        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: WORKING_HOURS_TIMEZONE,
            hour: "numeric",
            hour12: false,
        });

        let hour = parseInt(formatter.format(now), 10);

        // Some locales render midnight as "24" with hour12:false.
        if (hour === 24) hour = 0;

        return hour;
    }

    function isWithinWorkingHours(date) {
        const hour = getCurrentHour(date);

        if (WORKING_HOURS_START_HOUR <= WORKING_HOURS_END_HOUR) {
            return hour >= WORKING_HOURS_START_HOUR && hour < WORKING_HOURS_END_HOUR;
        }

        // Overnight window (e.g. 22 → 6): "open" if it's after start OR before end.
        return hour >= WORKING_HOURS_START_HOUR || hour < WORKING_HOURS_END_HOUR;
    }

    /* ----------------------------------------
     * PATIENT → DOCTOR PAIR HELPERS
     * ---------------------------------------- */

    /*
     * Accepts either the new { primary, secondary } shape or a legacy
     * plain doctorId string, so existing patientDoctorMap entries that
     * haven't been migrated yet keep working exactly as before.
     */
    function resolveDoctorPair(mapValue) {
        if (!mapValue) return { primary: null, secondary: null };

        if (typeof mapValue === "string") {
            return { primary: mapValue, secondary: null };
        }

        return {
            primary: mapValue.primary || null,
            secondary: mapValue.secondary || null,
        };
    }

    /*
     * A stable key identifying a doctor pair, independent of which one is
     * "primary" vs "secondary" so both doctors share the same queue.
     * Falls back to a single-doctor key when there is no secondary
     * (legacy behaviour: personal queue, no forwarding).
     */
    function pairKeyFor(primaryDoctorId, secondaryDoctorId) {
        if (!secondaryDoctorId) return primaryDoctorId;

        return [primaryDoctorId, secondaryDoctorId].sort().join("|");
    }

    function pairDoctorIds(pairKey) {
        return pairKey.split("|");
    }

    function otherDoctorInPair(pairKey, doctorId) {
        return pairDoctorIds(pairKey).find(function (id) {
            return id !== doctorId;
        }) || null;
    }

    /* ----------------------------------------
     * INBOUND STATE
     * ---------------------------------------- */

    const inboundPairs = new Map();
    const doctorToPairKeys = new Map();
    const calls = new Map();

    /* ----------------------------------------
     * HELPERS
     * ---------------------------------------- */

    function getPair(pairKey) {
        if (!inboundPairs.has(pairKey)) {
            inboundPairs.set(pairKey, {
                offeredCallId: null,
                offeredDoctorId: null,
                queue: [],
                offlineSince: null,
            });
        }

        return inboundPairs.get(pairKey);
    }

    function registerPair(pairKey, primaryDoctorId, secondaryDoctorId) {
        [primaryDoctorId, secondaryDoctorId].forEach(function (doctorId) {
            if (!doctorId) return;

            if (!doctorToPairKeys.has(doctorId)) {
                doctorToPairKeys.set(doctorId, new Set());
            }

            doctorToPairKeys.get(doctorId).add(pairKey);
        });
    }

    function pairKeysForDoctor(doctorId) {
        return Array.from(doctorToPairKeys.get(doctorId) || []);
    }

    function isDoctorCurrentlyOffered(doctorId) {
        for (const pair of inboundPairs.values()) {
            if (pair.offeredDoctorId === doctorId) return true;
        }

        return false;
    }

    function isDoctorFree(doctorId) {
        const state = getDoctorCallState(doctorId);

        return !state.busyReason && !state.activeCallId && !isDoctorCurrentlyOffered(doctorId);
    }

    function reasonDoctorUnavailable(doctorId) {
        if (!isDoctorOnline(doctorId)) return "offline";

        return "busy"; // online, but on another call (or otherwise not free)
    }

    /*
     * Walks a session's two allocated doctors in order, skipping any already
     * tried. The first untried candidate that is actually reachable right
     * now (online + free) is returned. Any candidate that is skipped for
     * being offline/busy is marked "tried" too (so we never get stuck
     * offering to someone who can't take the call) and the reason is
     * recorded on session.lastSkipReason — used to word the "forwarding"
     * announcement.
     */
    function pickAvailableDoctor(session) {
        const candidates = [session.primaryDoctorId, session.secondaryDoctorId];

        for (const doctorId of candidates) {
            if (!doctorId || session.triedDoctors.includes(doctorId)) continue;

            if (isDoctorOnline(doctorId) && isDoctorFree(doctorId)) {
                return doctorId;
            }

            session.lastSkipReason = reasonDoctorUnavailable(doctorId);
            session.triedDoctors.push(doctorId);
        }

        return null;
    }

    function queuePosition(session) {
        const index = getPair(session.pairKey).queue.indexOf(session.pstnCallId);

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
            if (session.pendingAnnouncement) {
                speech = session.pendingAnnouncement;
                session.pendingAnnouncement = null;
                session.announcedOffer = true;
            } else if (!session.announcedOffer) {
                speech = MESSAGES.connecting;
                session.announcedOffer = true;
            }

            pause = OFFER_HOLD_PAUSE_SECONDS;
        } else {
            const position = queuePosition(session);

            if (!session.announcedQueue) {
                speech =
                    "Your doctor is currently with another patient. You are number " +
                    position +
                    " in line. Please stay on the line and you will be connected as soon as your doctor is " +
                    "available, or hang up and try again later.";
            } else {
                speech = `You are number ${position} in line. Please continue to hold, or hang up and try again later.`;
            }

            session.announcedQueue = true;
            pause = QUEUE_HOLD_PAUSE_SECONDS;
        }

        return (
            (speech ? `<SpeakSentence>${xmlEscape(speech)}</SpeakSentence>` : "") +
            `<Pause duration="${pause}"/>` +
            `<Redirect redirectUrl="${xmlEscape(holdUrl(session.pstnCallId))}"/>`
        );
    }

    // >>> ADDED: shared BXML builder for the actual record step, used
    // wherever a recording actually starts — currently only the
    // "both doctors have now failed" IVR choice below.
    function voicemailRecordVerbs(session, maxDurationSeconds, promptMessage) {
        const recordingCallbackUrl =
            `${NGROK_URL}/api/callbacks/voice/recording-complete` +
            `?pstnCallId=${encodeURIComponent(session.pstnCallId)}`;

        return (
            `<SpeakSentence>${xmlEscape(promptMessage)}</SpeakSentence>` +
            `<Record recordingAvailableUrl="${xmlEscape(recordingCallbackUrl)}" ` +
            `maxDuration="${maxDurationSeconds}" fileFormat="${VOICEMAIL_FILE_FORMAT}"/>` +
            `<SpeakSentence>${xmlEscape(MESSAGES.voicemailThanks)}</SpeakSentence>` +
            `<Hangup/>`
        );
    }

    // >>> ADDED: takes a session out of "awaiting choice" / QUEUED state the
    // moment the patient opts into voicemail via keypad, so dispatchNext()
    // never tries to ring a doctor for a caller who is now mid-recording.
    function beginVoicemailRecording(session) {
        session.status = "RECORDING";

        const pair = getPair(session.pairKey);

        pair.queue = pair.queue.filter(function (id) {
            return id !== session.pstnCallId;
        });

        broadcastQueueForPair(session.pairKey);
    }

    /*
     * Send a doctor the current waiting list. Aggregates every pair this
     * doctor is part of (normally just one) into a single "waiting for
     * me" view, since a patient's queue entry is shared with their other
     * allocated doctor.
     */

    function broadcastQueue(doctorId) {
        if (!doctorId) return;

        const now = Date.now();
        const waiting = [];

        for (const pairKey of pairKeysForDoctor(doctorId)) {
            const pair = getPair(pairKey);

            pair.queue.forEach(function (pstnCallId, index) {
                const session = calls.get(pstnCallId);

                if (!session) return;

                waiting.push({
                    pstnCallId: pstnCallId,
                    patientId: session.patientId,
                    from: session.from,
                    position: index + 1,
                    waitingSeconds: Math.round((now - session.createdAt) / 1000),
                    sharedWithDoctorId: otherDoctorInPair(pairKey, doctorId),
                });
            });
        }

        waiting.sort(function (a, b) {
            return b.waitingSeconds - a.waitingSeconds;
        });

        sendDoctorEvent(doctorId, {
            type: "inboundQueueUpdated",
            doctorId: doctorId,
            count: waiting.length,
            waiting: waiting,
        });
    }

    function broadcastQueueForPair(pairKey) {
        pairDoctorIds(pairKey).forEach(broadcastQueue);
    }

    // >>> ADDED: pings a doctor who is currently ON AN ACTIVE CALL (not just
    // offline, and not the doctor currently being rung — they already see
    // the incoming call itself) to let them know another patient has called
    // in and is waiting. Lightweight notification, distinct from the
    // queue-count update broadcastQueueForPair() already sends.
    function notifyBusyDoctorsOfWaitingPatient(session) {
        pairDoctorIds(session.pairKey).forEach(function (doctorId) {
            const state = getDoctorCallState(doctorId);

            if (state.busyReason && state.activeCallId) {
                sendDoctorEvent(doctorId, {
                    type: "patientWaitingNotification",
                    doctorId: doctorId,
                    pstnCallId: session.pstnCallId,
                    patientId: session.patientId,
                    from: session.from,
                    position: queuePosition(session),
                });
            }
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

    function nudgeCallerToAnnouncement(session) {
        redirectVoiceCall(session.pstnCallId, holdUrl(session.pstnCallId)).catch(function (error) {
            console.log(
                "Fast-forward nudge failed (caller will still hear the announcement via the normal hold loop):",
                session.pstnCallId,
                error.response?.data || error.message,
            );
        });
    }

    // >>> ADDED: redirects the live call into the voicemail CHOICE flow —
    // this only happens once BOTH allocated doctors have failed via ring
    // timeout (or offline/busy at initial routing), never for a Decline
    // click and never for the plain "one doctor currently busy, please
    // hold" queue case.
    function redirectToVoicemailChoice(session) {
        const url =
            `${NGROK_URL}/api/callbacks/voice/inbound-voicemail-choice` +
            `?pstnCallId=${encodeURIComponent(session.pstnCallId)}`;

        redirectVoiceCall(session.pstnCallId, url).catch(function (error) {
            console.error(
                "Failed to redirect caller to voicemail choice:",
                session.pstnCallId,
                error.response?.data || error.message,
            );
        });
    }

    // >>> CHANGED: terminal step once both allocated doctors have failed a
    // ring timeout (or were found offline/busy). Previously this forced
    // the caller straight into a recording. Now it offers the IVR choice
    // instead (press 1 = leave voicemail, press 2 = keep holding) — the
    // actual recording only starts if the patient chooses it via the
    // gather callback below.
    function offerVoicemailChoice(session) {
        console.log(
            "Both doctors unavailable — offering voicemail choice via IVR:",
            session.pstnCallId,
        );

        session.status = "AWAITING_VOICEMAIL_CHOICE";
        endOffer(session);

        const pair = getPair(session.pairKey);

        pair.queue = pair.queue.filter(function (id) {
            return id !== session.pstnCallId;
        });

        redirectToVoicemailChoice(session);
        broadcastQueueForPair(session.pairKey);
    }

    function endOffer(session) {
        clearTimeout(session.ringTimer);
        session.ringTimer = null;

        const pair = getPair(session.pairKey);

        if (pair.offeredCallId === session.pstnCallId) {
            pair.offeredCallId = null;
            pair.offeredDoctorId = null;
        }
    }

    function requeueFront(session) {
        session.status = "QUEUED";
        session.announcedQueue = false;
        session.lastAttemptAt = Date.now();

        const pair = getPair(session.pairKey);

        if (!pair.queue.includes(session.pstnCallId)) {
            pair.queue.unshift(session.pstnCallId);
        }
    }

    function removeCall(session) {
        calls.delete(session.pstnCallId);

        const pair = getPair(session.pairKey);

        pair.queue = pair.queue.filter(function (id) {
            return id !== session.pstnCallId;
        });

        endOffer(session);
    }

    /* ----------------------------------------
     * RING A DOCTOR (session.currentDoctorId decides which one)
     * ---------------------------------------- */

    function offerToDoctor(session) {
        const doctorId = session.currentDoctorId;
        const pair = getPair(session.pairKey);
        const endpointId = doctorEndpointMap.get(doctorId);

        session.status = "OFFERED";
        session.endpointId = endpointId;
        session.announcedOffer = false;

        pair.offeredCallId = session.pstnCallId;
        pair.offeredDoctorId = doctorId;

        const sent = sendDoctorEvent(doctorId, {
            type: "incomingPstnCall",
            pstnCallId: session.pstnCallId,
            doctorId: doctorId,
            endpointId: endpointId,
            patientId: session.patientId,
            from: session.from,
            to: session.to,
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

        console.log("Ringing doctor:", doctorId, "| PSTN call:", session.pstnCallId);

        return true;
    }

    function onOfferMissed(pstnCallId) {
        const session = calls.get(pstnCallId);

        if (!session || session.status !== "OFFERED") return;

        const missedDoctorId = session.currentDoctorId;

        console.log("Doctor did not answer in time:", missedDoctorId, pstnCallId);

        sendDoctorEvent(missedDoctorId, {
            type: "incomingPstnCallCancelled",
            pstnCallId: pstnCallId,
            doctorId: missedDoctorId,
            reason: "missed",
        });

        session.triedDoctors.push(missedDoctorId);
        session.lastSkipReason = "missed";
        endOffer(session);

        forwardOrRecord(session);
    }

    /*
     * Shared by a ring timeout (onOfferMissed) and a Decline click. Tries
     * the other allocated doctor if one is available; otherwise offers
     * the voicemail choice rather than placing the caller back in the
     * shared hold queue.
     */
    function forwardOrRecord(session) {
        const nextDoctorId = pickAvailableDoctor(session);

        if (nextDoctorId) {
            session.currentDoctorId = nextDoctorId;

            const reasonText = MESSAGES.reason[session.lastSkipReason] || MESSAGES.reason.missed;

            session.pendingAnnouncement = `${reasonText} ${MESSAGES.secondaryForward}`;

            offerToDoctor(session);
            broadcastQueueForPair(session.pairKey);
            nudgeCallerToAnnouncement(session);

            return;
        }

        offerVoicemailChoice(session);
    }

    /* ----------------------------------------
     * NEXT PATIENT IN A DOCTOR'S SHARED QUEUE(S)
     * (also called by server.js when the doctor becomes free)
     * ---------------------------------------- */

    function dispatchNext(doctorId) {
        if (!isDoctorFree(doctorId) || !isDoctorOnline(doctorId)) return;

        let bestPairKey = null;
        let bestSession = null;

        for (const pairKey of pairKeysForDoctor(doctorId)) {
            const pair = getPair(pairKey);

            pair.queue = pair.queue.filter(function (id) {
                return calls.has(id);
            });

            for (const pstnCallId of pair.queue) {
                const session = calls.get(pstnCallId);

                if (!bestSession || session.createdAt < bestSession.createdAt) {
                    bestSession = session;
                    bestPairKey = pairKey;
                }
            }
        }

        if (!bestSession) return;

        const pair = getPair(bestPairKey);

        pair.queue = pair.queue.filter(function (id) {
            return id !== bestSession.pstnCallId;
        });

        console.log("Next patient in queue for", doctorId, "→", bestSession.pstnCallId);

        bestSession.currentDoctorId = doctorId;

        if (bestSession.triedDoctors.length > 0) {
            bestSession.pendingAnnouncement = MESSAGES.retryFromQueue;
        }

        offerToDoctor(bestSession);

        broadcastQueueForPair(bestPairKey);
    }

    function dispatchNextForPair(pairKey) {
        const [doctorAId, doctorBId] = pairDoctorIds(pairKey);

        if (isDoctorFree(doctorAId) && isDoctorOnline(doctorAId)) {
            return dispatchNext(doctorAId);
        }

        if (doctorBId && isDoctorFree(doctorBId) && isDoctorOnline(doctorBId)) {
            return dispatchNext(doctorBId);
        }
    }

    /* ----------------------------------------
     * CALLER GONE (hung up / ended)
     * ---------------------------------------- */

    function handleCallGone(pstnCallId, options) {
        const session = calls.get(pstnCallId);

        if (!session) return false;

        const notifyDoctor = !options || options.notifyDoctor !== false;
        const previousStatus = session.status;
        const engagedDoctorId = session.currentDoctorId;
        const doctorState = engagedDoctorId ? getDoctorCallState(engagedDoctorId) : null;

        removeCall(session);

        console.log("Inbound caller gone:", pstnCallId, "| was:", previousStatus);

        if (previousStatus === "OFFERED") {
            if (notifyDoctor && engagedDoctorId) {
                sendDoctorEvent(engagedDoctorId, {
                    type: "incomingPstnCallEnded",
                    pstnCallId: pstnCallId,
                    doctorId: engagedDoctorId,
                });
            }

            setTimeout(function () {
                dispatchNextForPair(session.pairKey);
            }, AFTER_CALL_DISPATCH_DELAY_MS);
        }

        if (
            (previousStatus === "CONNECTING" || previousStatus === "CONNECTED") &&
            doctorState &&
            doctorState.activeCallId === pstnCallId
        ) {
            if (notifyDoctor && engagedDoctorId) {
                sendDoctorEvent(engagedDoctorId, {
                    type: "incomingPstnCallEnded",
                    pstnCallId: pstnCallId,
                    doctorId: engagedDoctorId,
                });
            }

            markDoctorFree(engagedDoctorId, DISCONNECT_DISPATCH_DELAY_MS);
        }

        broadcastQueueForPair(session.pairKey);

        return true;
    }

    function handleDisconnect(event) {
        return handleCallGone(event.callId);
    }

    async function endActiveCall(pstnCallId) {
        const session = calls.get(pstnCallId);

        if (!session) return;

        await endVoiceCallSafe(pstnCallId);

        removeCall(session);
        broadcastQueueForPair(session.pairKey);
    }

    /* ----------------------------------------
     * INBOUND CALL INITIATED
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/initiate", function (req, res) {
        const callId = req.body?.callId;
        const from = req.body?.from;
        const to = req.body?.to;

        console.log("=================================");
        console.log("Inbound call:", callId, "| from:", from, "| to:", to);

        if (!isWithinWorkingHours()) {
            console.log(
                "Call received outside working hours (",
                WORKING_HOURS_START_HOUR + ":00", "-", WORKING_HOURS_END_HOUR + ":00",
                WORKING_HOURS_TIMEZONE || "server local time",
                ")",
            );

            return sendBxml(res, unavailableVerbs("outsideWorkingHours"));
        }

        const patientId = getPatientIdFromPhone(from);
        const { primary: primaryDoctorId, secondary: secondaryDoctorId } = resolveDoctorPair(
            patientId ? patientDoctorMap.get(patientId) : null,
        );

        console.log(
            "Patient:", patientId || "UNKNOWN",
            "| Primary doctor:", primaryDoctorId || "NONE",
            "| Secondary doctor:", secondaryDoctorId || "NONE",
        );
        console.log("=================================");

        if (!callId || !primaryDoctorId) {
            return sendBxml(res, unavailableVerbs("unknown"));
        }

        const pairKey = pairKeyFor(primaryDoctorId, secondaryDoctorId);

        registerPair(pairKey, primaryDoctorId, secondaryDoctorId);

        const pair = getPair(pairKey);

        if (pair.queue.length >= MAX_QUEUE_SIZE) {
            console.log("Queue full for doctor pair:", pairKey);

            return sendBxml(res, unavailableVerbs("full"));
        }

        const session = {
            pstnCallId: callId,
            patientId: patientId,
            primaryDoctorId: primaryDoctorId,
            secondaryDoctorId: secondaryDoctorId,
            currentDoctorId: null,
            triedDoctors: [],
            lastSkipReason: null,
            pairKey: pairKey,
            from: from,
            to: to,
            status: "QUEUED",
            endpointId: null,
            ringTimer: null,
            announcedOffer: false,
            announcedQueue: false,
            pendingAnnouncement: null,
            lastAttemptAt: 0,
            createdAt: Date.now(),
            lastSeen: Date.now(),
        };

        calls.set(callId, session);

        const availableDoctorId = pair.queue.length === 0 ? pickAvailableDoctor(session) : null;

        if (availableDoctorId) {
            session.currentDoctorId = availableDoctorId;

            if (session.triedDoctors.length > 0) {
                const reasonText = MESSAGES.reason[session.lastSkipReason] || MESSAGES.reason.offline;

                session.pendingAnnouncement = `${reasonText} ${MESSAGES.secondaryForward}`;
            }

            offerToDoctor(session);
        } else {
            pair.queue.push(callId);

            console.log(
                "No allocated doctor available, patient queued:",
                pairKey,
                "| position:",
                pair.queue.length,
            );

            // >>> ADDED: original "both busy/offline right now" queueing
            // case — let any doctor in the pair who is genuinely mid-call
            // know a patient is waiting for them.
            notifyBusyDoctorsOfWaitingPatient(session);
        }

        broadcastQueueForPair(pairKey);

        sendBxml(res, holdVerbs(session));
    });

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
            broadcastQueueForPair(session.pairKey);

            return sendBxml(res, unavailableVerbs("timeout"));
        }

        if (session.status === "QUEUED" || session.status === "OFFERED") {
            return sendBxml(res, holdVerbs(session));
        }

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
     * VOICEMAIL
     * ---------------------------------------- */

    // >>> CHANGED: this now plays the CHOICE prompt (press 1 / press 2) via
    // <Gather>, instead of forcing straight into a recording. Only reached
    // once both allocated doctors have already been tried and failed.
    app.post("/api/callbacks/voice/inbound-voicemail-choice", function (req, res) {
        const session = calls.get(req.query.pstnCallId);

        if (!session) {
            return sendBxml(res, "<Hangup/>");
        }

        const gatherUrl =
            `${NGROK_URL}/api/callbacks/voice/inbound-voicemail-choice-gather` +
            `?pstnCallId=${encodeURIComponent(session.pstnCallId)}`;

        const bxml =
            `<Gather gatherUrl="${xmlEscape(gatherUrl)}" maxDigits="1" firstDigitTimeout="8">` +
            `<SpeakSentence>${xmlEscape(MESSAGES.voicemailChoicePrompt)}</SpeakSentence>` +
            `</Gather>`;

        sendBxml(res, bxml);
    });

    // >>> ADDED: fires once the caller responds to the voicemail choice —
    // press 1 = start the 30-second recording; press 2 (or no input within
    // the timeout) = go back into the shared queue and resume the normal,
    // plain hold loop (no further IVR prompts on subsequent cycles).
    // NOTE: verify the exact field name Bandwidth uses for the collected
    // digit(s) in this callback's JSON body against your account's Gather
    // reference — "digits" is used here as the common convention, but
    // confirm before relying on this in production.
    app.post("/api/callbacks/voice/inbound-voicemail-choice-gather", function (req, res) {
        const session = calls.get(req.query.pstnCallId);

        if (!session) {
            return sendBxml(res, "<Hangup/>");
        }

        const digits = (req.body && (req.body.digits || req.body.digit)) || "";

        if (digits === "1") {
            console.log("Patient pressed 1 — leaving a voicemail:", session.pstnCallId);

            beginVoicemailRecording(session);

            return sendBxml(
                res,
                voicemailRecordVerbs(
                    session,
                    QUEUE_OPT_IN_VOICEMAIL_MAX_DURATION_SECONDS,
                    MESSAGES.voicemailRecordPrompt,
                ),
            );
        }

        if (digits === "2") {
            console.log("Patient pressed 2 — chose to keep holding:", session.pstnCallId);
        } else {
            console.log("No response to voicemail choice — defaulting to keep holding:", session.pstnCallId);
        }

        // Back into the shared queue, plain hold loop from here on (no more
        // IVR prompts — the choice was already offered once).
        requeueFront(session);
        broadcastQueueForPair(session.pairKey);

        sendBxml(res, holdVerbs(session));
    });

    // NOTE: verify the exact field names (mediaUrl, duration, recordingId,
    // etc.) against your Bandwidth account's actual webhook payload — these
    // can vary slightly by API version.
    app.post("/api/callbacks/voice/recording-complete", function (req, res) {
        const session = calls.get(req.query.pstnCallId);
        const event = req.body || {};

        console.log("Recording completed for:", req.query.pstnCallId, "| mediaUrl:", event.mediaUrl);

        if (session) {
            pairDoctorIds(session.pairKey).forEach(function (doctorId) {
                sendDoctorEvent(doctorId, {
                    type: "patientVoicemail",
                    doctorId: doctorId,
                    pstnCallId: session.pstnCallId,
                    patientId: session.patientId,
                    from: session.from,
                    mediaUrl: event.mediaUrl,
                    duration: event.duration,
                    recordedAt: Date.now(),
                });
            });

            removeCall(session);
            broadcastQueueForPair(session.pairKey);
        }

        res.status(200).end();
    });

    // Doctor's browser hits this instead of the raw Bandwidth mediaUrl,
    // since that URL requires Basic Auth with your Bandwidth account
    // credentials that the browser doesn't (and shouldn't) have.
    app.get("/api/recordings/proxy", async function (req, res) {
        const { mediaUrl } = req.query;

        if (!mediaUrl) {
            return res.status(400).json({ success: false, message: "mediaUrl is required" });
        }

        if (!BANDWIDTH_USERNAME || !BANDWIDTH_PASSWORD) {
            return res.status(500).json({
                success: false,
                message: "Bandwidth credentials are not configured on the server",
            });
        }

        try {
            const response = await axios.get(mediaUrl, {
                auth: { username: BANDWIDTH_USERNAME, password: BANDWIDTH_PASSWORD },
                responseType: "stream",
            });

            res.set("Content-Type", response.headers["content-type"] || "audio/mpeg");
            response.data.pipe(res);
        } catch (error) {
            console.error("Failed to fetch recording:", error.response?.data || error.message);
            res.status(502).json({ success: false, message: "Could not fetch recording" });
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
     *
     * >>> REVERTED: back to forwarding, same as a missed ring timeout.
     * Decline tries the other allocated doctor first (via
     * forwardOrRecord()); if that doctor also fails, the caller is
     * offered the voicemail choice instead of the call ending outright.
     * ---------------------------------------- */

    app.post("/api/calls/inbound/decline", function (req, res) {
        const { pstnCallId, doctorId } = req.body || {};
        const session = calls.get(pstnCallId);

        if (!session || session.currentDoctorId !== doctorId) {
            return res.status(404).json({ success: false, message: "Inbound call not found" });
        }

        if (session.status !== "OFFERED") {
            return res.status(409).json({ success: false, message: "Call is not ringing" });
        }

        console.log("Doctor declined:", doctorId, pstnCallId);

        session.triedDoctors.push(doctorId);
        session.lastSkipReason = "declined";
        endOffer(session);
        forwardOrRecord(session);

        res.json({ success: true, pstnCallId: pstnCallId, doctorId: doctorId });
    });

    /* ----------------------------------------
     * BROWSER WAS BUSY WHEN THE CALL RANG
     * (unchanged — still queues, since this is a browser-level hiccup,
     * not a decline/miss)
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

        if (session && session.currentDoctorId === doctorId && session.status === "OFFERED") {
            endOffer(session);
            requeueFront(session);
            broadcastQueueForPair(session.pairKey);

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

        handleCallGone(pstnCallId, { notifyDoctor: false });

        res.json({ success: true, pstnCallId: pstnCallId });
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

        if (!session || session.currentDoctorId !== doctorId) {
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
            broadcastQueueForPair(session.pairKey);

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

            const pairKey = session.pairKey;

            removeCall(session);
            markDoctorFree(doctorId, AFTER_CALL_DISPATCH_DELAY_MS);
            broadcastQueueForPair(pairKey);

            res.status(502).json({
                success: false,
                message: "Failed to connect call to doctor (caller may have hung up)",
                error: error.response?.data || error.message,
            });
        }
    });

    /* ----------------------------------------
     * QUEUE STATUS (debugging)
     * ---------------------------------------- */

    app.get("/api/inbound/queue", function (req, res) {
        const result = {};

        for (const [pairKey, pair] of inboundPairs.entries()) {
            result[pairKey] = {
                doctors: pairDoctorIds(pairKey).map(function (doctorId) {
                    const state = getDoctorCallState(doctorId);

                    return {
                        doctorId: doctorId,
                        online: isDoctorOnline(doctorId),
                        busyReason: state.busyReason,
                        activeCallId: state.activeCallId,
                    };
                }),
                offeredCallId: pair.offeredCallId,
                offeredDoctorId: pair.offeredDoctorId,
                queue: pair.queue.map(function (id) {
                    const session = calls.get(id);

                    return session
                        ? { pstnCallId: id, patientId: session.patientId, from: session.from }
                        : { pstnCallId: id };
                }),
            };
        }

        res.json({ success: true, pairs: result });
    });

    /* ----------------------------------------
     * SWEEPER
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

        for (const [pairKey, pair] of inboundPairs.entries()) {
            const hasWaiting = pair.queue.length > 0 || Boolean(pair.offeredCallId);

            if (!hasWaiting) {
                pair.offlineSince = null;

                continue;
            }

            const [doctorAId, doctorBId] = pairDoctorIds(pairKey);
            const anyOnline = isDoctorOnline(doctorAId) || (doctorBId && isDoctorOnline(doctorBId));

            if (anyOnline) {
                pair.offlineSince = null;

                dispatchNextForPair(pairKey);

                continue;
            }

            pair.offlineSince = pair.offlineSince || now;

            if (now - pair.offlineSince < OFFLINE_GRACE_MS) continue;

            console.log("Both doctors offline, releasing queue:", pairKey);

            const waitingIds = pair.queue.concat(pair.offeredCallId || []);

            for (const pstnCallId of waitingIds) {
                const session = calls.get(pstnCallId);

                if (!session) continue;

                redirectToUnavailable(session, "offline");
                removeCall(session);
            }

            pair.queue = [];
            pair.offlineSince = null;

            broadcastQueueForPair(pairKey);
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