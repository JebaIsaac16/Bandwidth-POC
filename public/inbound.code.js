/*
 * ========================================
 * INBOUND CALL LOGIC (patient calls doctor)
 * ========================================
 *
 * Loaded BEFORE code.js. code.js attaches these methods
 * to the main instance with:
 *
 *   window.bandwidthInboundMixin.call(this);
 *
 * Handles:
 * - incoming call ringing UI
 * - accept / decline
 * - "N patients waiting" badge + toast while the doctor is busy
 * - returning an offer to the queue if the doctor is busy
 * - patient hang-up (while ringing or connected)
 *
 * ADDED IN THIS VERSION:
 * - Cross-tab sync via BroadcastChannel, so the incoming call popup
 *   shows on EVERY open tab of the app, not just the tab that
 *   happens to hold the live socket connection.
 * - Desktop Notification + flashing tab title, so the doctor notices
 *   an incoming call even if they're on a different tab/app entirely.
 *
 * NOTE: make sure the #active_call_window markup + the 5 <script>
 * tags (jquery, bandwidth.bundle.js, outbound.code.js, inbound.code.js,
 * code.js) are present on every page of the app, not only index.html,
 * if you also need this to work across separate HTML pages (not just
 * separate tabs of the same page).
 */

window.bandwidthInboundMixin = function () {
    /*
     * ----------------------------------------
     * INBOUND STATE
     * ----------------------------------------
     */

    this.incomingStreamInfo = null;
    this.inboundCallActive = false; // connected inbound call
    this.incomingCallActive = false; // ringing or connected inbound call
    this.incomingCallAccepted = false;
    this.incomingBrtcConnected = false;
    this.incomingPstnCallId = null;
    this.incomingPatientId = null;
    this.incomingPatient = null;
    this.incomingFrom = null;
    this.incomingTo = null;
    this.incomingConnectTimer = null;

    this.lastQueueCount = 0;
    this.$queueBadge = null;
    this.$queueToast = null;
    this.queueToastTimer = null;

    /*
     * ----------------------------------------
     * CROSS-TAB SYNC STATE
     * ----------------------------------------
     */

    this.callChannel = ("BroadcastChannel" in window)
        ? new BroadcastChannel("bandwidth_inbound_calls")
        : null;

    this._originalTitle = null;
    this._titleFlashTimer = null;
    this._callNotification = null;

    /*
     * ----------------------------------------
     * SERVER EVENTS (called by code.js)
     * Returns true when the event was handled here.
     * ----------------------------------------
     */

    this.handleInboundDoctorEvent = function (data) {
        switch (data.type) {
            case "incomingPstnCall":
                this.broadcastToOtherTabs("incomingPstnCall", data);
                this.handleIncomingPstnCall(data);
                return true;

            case "incomingPstnCallCancelled":
                this.broadcastToOtherTabs("incomingPstnCallCancelled", data);
                this.handleIncomingCallCancelled(data);
                return true;

            case "incomingPstnCallEnded":
                this.broadcastToOtherTabs("incomingPstnCallEnded", data);
                this.handleIncomingCallEnded(data);
                return true;

            case "inboundQueueUpdated":
                this.handleInboundQueueUpdated(data);
                return true;

            default:
                return false;
        }
    };

    /*
     * ----------------------------------------
     * CROSS-TAB SYNC (BroadcastChannel)
     *
     * Only ONE tab actually holds the live socket connection to
     * the backend at any given moment. Whichever tab receives the
     * event re-broadcasts it here so every other open tab of the
     * same app (same origin) can show the popup locally too.
     *
     * Duplicate delivery is safe: handleIncomingPstnCall already
     * ignores a pstnCallId it has already seen.
     * ----------------------------------------
     */

    this.initCallChannelListener = function () {
        if (!this.callChannel) {
            console.warn(
                "BroadcastChannel not supported in this browser; " +
                    "cross-tab call sync is disabled.",
            );

            return;
        }

        this.callChannel.onmessage = function (event) {
            const msg = event.data;

            if (!msg || !msg.type) {
                return;
            }

            switch (msg.type) {
                case "incomingPstnCall":
                    this.handleIncomingPstnCall(msg.payload);
                    break;

                case "incomingPstnCallCancelled":
                    this.handleIncomingCallCancelled(msg.payload);
                    break;

                case "incomingPstnCallEnded":
                    this.handleIncomingCallEnded(msg.payload);
                    break;

                default:
                    break;
            }
        }.bind(this);
    };

    this.broadcastToOtherTabs = function (type, payload) {
        if (!this.callChannel) {
            return;
        }

        try {
            this.callChannel.postMessage({ type: type, payload: payload });
        } catch (error) {
            console.warn("Failed to broadcast to other tabs:", error);
        }
    };

    /*
     * ----------------------------------------
     * QUEUE UI
     * ----------------------------------------
     */

    this.initInboundQueueUi = function () {
        if (!this.$queueBadge) {
            this.$queueBadge = $(
                '<span id="inbound_queue_badge" class="badge rounded-pill text-bg-warning d-none"></span>',
            );
            $(this.selectors.doctorStatus).before(this.$queueBadge);
        }

        if (!this.$queueToast) {
            this.$queueToast = $(
                '<div id="inbound_queue_toast" class="alert alert-warning shadow-sm d-none" role="status"></div>',
            ).css({
                position: "fixed",
                top: "16px",
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 10000,
                minWidth: "280px",
                textAlign: "center",
            });

            $("body").append(this.$queueToast);
        }
    };

    this.showQueueToast = function (message) {
        if (!this.$queueToast) {
            return;
        }
        this.$queueToast.text(message).removeClass("d-none");
        clearTimeout(this.queueToastTimer);

        this.queueToastTimer = setTimeout(
            function () {
                this.$queueToast.addClass("d-none");
            }.bind(this),
            6000,
        );
    };
    this.handleInboundQueueUpdated = function (data) {
        const waiting = Array.isArray(data.waiting) ? data.waiting : [];
        const count = waiting.length;
        if (this.$queueBadge) {
            this.$queueBadge
                .toggleClass("d-none", count === 0)
                .text(
                    count === 1
                        ? "1 patient waiting"
                        : count + " patients waiting",
                )
                .attr(
                    "title",
                    waiting
                        .map(
                            function (item) {
                                return (
                                    "#" +
                                    item.position +
                                    " " +
                                    this.getPatientDisplayName(
                                        item.patientId,
                                        item.from,
                                    )
                                );
                            }.bind(this),
                        )
                        .join("\n"),
                );
        }

        if (count > this.lastQueueCount) {
            const newest = waiting[waiting.length - 1];

            this.showQueueToast(
                this.getPatientDisplayName(newest.patientId, newest.from) +
                    " is waiting (position " +
                    newest.position +
                    ")",
            );
        }

        this.lastQueueCount = count;
    };

    this.resetInboundQueueUi = function () {
        this.lastQueueCount = 0;

        if (this.$queueBadge) {
            this.$queueBadge.addClass("d-none").text("").attr("title", "");
        }

        if (this.$queueToast) {
            this.$queueToast.addClass("d-none");
        }
    };

    /*
     * ----------------------------------------
     * INCOMING CALL OFFER
     * ----------------------------------------
     */

    this.handleIncomingPstnCall = function (callData) {
        console.log("Incoming PSTN call notification:", callData);

        if (!callData || !callData.pstnCallId) {
            console.warn(
                "Incoming PSTN notification does not contain pstnCallId.",
            );

            return;
        }

        if (callData.doctorId && callData.doctorId !== this.doctorId) {
            console.warn("Incoming call belongs to another doctor.");

            return;
        }

        if (this.incomingPstnCallId === callData.pstnCallId) {
            return; // duplicate
        }

        /*
         * Doctor busy → send the patient back to the front of the queue.
         */

        const isBusy =
            Boolean(this.activePatient) ||
            this.incomingCallActive ||
            this.isCallEnding ||
            this.isRemoteEnding ||
            Boolean(this.cleanupTimer);

        if (isBusy) {
            console.log(
                "Doctor busy, returning call to queue:",
                callData.pstnCallId,
            );

            this.postJson("/api/calls/inbound/busy", {
                pstnCallId: callData.pstnCallId,
                doctorId: this.doctorId,
            }).fail(function (xhr) {
                console.error(
                    "Failed to return call to queue:",
                    xhr.responseJSON || xhr.responseText || xhr.status,
                );
            });

            return;
        }

        this.incomingPstnCallId = callData.pstnCallId;
        this.incomingPatientId = callData.patientId || null;
        this.incomingFrom = callData.from || null;
        this.incomingTo = callData.to || null;

        this.incomingPatient = {
            id: callData.patientId || "UNKNOWN",
            name:
                callData.patientName ||
                this.getPatientDisplayName(
                    callData.patientId,
                    "Unknown caller",
                ),
            phoneNumber:
                callData.patientPhoneNumber || callData.from || "Incoming call",
        };

        this.incomingCallActive = true;
        this.incomingCallAccepted = false;
        this.incomingStreamInfo = null;
        this.incomingBrtcConnected = false;
        this.inboundCallActive = true;

        this.showIncomingCall();
    };

    this.showIncomingCall = function () {

        const callWindow = $("#active_call_window");

        if (!callWindow.length) {
            console.error("Global call window not found.");
            return;
        }

        const pipOpen =
            this.pictureInPictureWindow && !this.pictureInPictureWindow.closed;

        callWindow.removeClass("is-pip");

        // If the floating PiP window is open, the call shows THERE
        // (on top of other apps). Keep the in-page copy hidden.
        if (!pipOpen) {
            callWindow.css({
                display: "block",
                position: "fixed",
                zIndex: 99999
            });
        }

        const patient = this.incomingPatient;

        $(this.selectors.callPatientName)
            .text(patient?.name || "Patient");

        $(this.selectors.callPatientNumber)
            .text(patient?.phoneNumber || "");

        $(this.selectors.callStatus)
            .text("Incoming call");

        $(this.selectors.callDuration)
            .text("00:00");

        // Show ringing
        $(this.selectors.callRingingIndicator)
            .removeClass("d-none");

        // Show incoming buttons
        $(this.selectors.incomingCallControls)
            .removeClass("d-none");

        // Hide active-call buttons
        $(this.selectors.activeCallControls)
            .addClass("d-none");

        this.startIncomingRingtone();

        // Flash the tab title + fire a desktop notification so the
        // doctor notices even if they're on a different tab/app.
        this.startIncomingAttentionAlert(patient);
    };

    /*
     * ----------------------------------------
     * ATTENTION ALERT (tab title flash + desktop notification)
     * ----------------------------------------
     */

    this.startIncomingAttentionAlert = function (patient) {
        this._originalTitle = this._originalTitle || document.title;

        clearInterval(this._titleFlashTimer);

        this._titleFlashTimer = setInterval(
            function () {
                document.title =
                    document.title === this._originalTitle
                        ? "\u260E Incoming call..."
                        : this._originalTitle;
            }.bind(this),
            1000,
        );

        if (!("Notification" in window)) {
            return;
        }

        /*
         * Permission can NOT be requested here: this runs from a
         * server event, not a click, so browsers ignore the request.
         * It is requested on Login / first click (code.js).
         */

        if (Notification.permission === "granted") {
            this._sendCallNotification(patient);
        } else {
            console.warn(
                "Desktop notifications are '" +
                    Notification.permission +
                    "'. Incoming calls cannot be shown outside the page.",
            );
        }
    };

    this._sendCallNotification = function (patient) {
        if (!("serviceWorker" in navigator)) {
            return; // no action-button support without a service worker
        }

        navigator.serviceWorker.ready
            .then(
                function (registration) {
                    return registration.showNotification("Incoming call", {
                        body: (patient?.name || "Patient") + " is calling",
                        tag: "bandwidth-incoming-call",
                        renotify: true,
                        requireInteraction: true,
                        actions: [
                            { action: "decline", title: "Decline" },
                            { action: "accept", title: "Accept" },
                        ],
                        data: {
                            pstnCallId: this.incomingPstnCallId,
                            doctorId: this.doctorId,
                        },
                    });
                }.bind(this),
            )
            .catch(function (error) {
                console.warn("Failed to show call notification:", error);
            });
    };

    this.stopIncomingAttentionAlert = function () {
        clearInterval(this._titleFlashTimer);
        this._titleFlashTimer = null;

        if (this._callNotification) {
            try {
                this._callNotification.close();
            } catch (error) {
                // already closed
            }

            this._callNotification = null;
        }

        if (this._originalTitle) {
            document.title = this._originalTitle;
        }
    };

    /*
     * ----------------------------------------
     * ACCEPT
     * ----------------------------------------
     */

    this.acceptIncomingCall = async function () {
        if (!this.incomingCallActive || !this.incomingPstnCallId) {
            console.warn("No incoming call is waiting.");

            return;
        }

        if (this.incomingCallAccepted) {
            return; // double click
        }

        const doctorSession = this.getDoctorSession();

        if (!doctorSession || !doctorSession.endpointId || !this.doctorId) {
            console.error("Doctor BRTC session is unavailable.");

            return;
        }

        const pstnCallId = this.incomingPstnCallId;

        console.log("Accepting incoming PSTN call:", pstnCallId);

        // Must run before any await (needs the click's user activation).
        this.openCallPictureInPicture();

        this.stopIncomingRingtone();
        this.stopIncomingAttentionAlert();

        $(this.selectors.callStatus).text("Connecting...");
        $(this.selectors.incomingCallControls).addClass("d-none");
        $(this.selectors.callRingingIndicator).addClass("d-none");

        // Set BEFORE the server connects the call, so the stream
        // is recognised even if it arrives before the AJAX response.
        this.incomingCallAccepted = true;

        try {
            // Make sure the mic is published (no-op if it already is).
            const micReady = await this.startMicrophone();

            if (!micReady) {
                throw new Error("Unable to access microphone.");
            }

            const response = await this.postJson("/api/calls/inbound/accept", {
                pstnCallId: pstnCallId,
                doctorId: this.doctorId,
                endpointId: doctorSession.endpointId,
            });

            console.log("Inbound call accept response:", response);

            if (!response || !response.success) {
                throw new Error(
                    response?.message || "Backend rejected the incoming call.",
                );
            }

            /*
             * If audio never arrives, don't leave the doctor stuck
             * on "Connecting..." with no buttons.
             */

            this.clearIncomingConnectTimer();

            this.incomingConnectTimer = setTimeout(
                function () {
                    if (
                        this.incomingPstnCallId === pstnCallId &&
                        !this.incomingBrtcConnected
                    ) {
                        console.error(
                            "Incoming stream never arrived:",
                            pstnCallId,
                        );

                        this.postJson("/api/calls/inbound/end", {
                            pstnCallId: pstnCallId,
                            doctorId: this.doctorId,
                        });

                        this.handleRemoteHangup("Call failed");
                    }
                }.bind(this),
                15000,
            );
        } catch (error) {
            console.error(
                "Failed to accept incoming PSTN call:",
                error.responseJSON || error.responseText || error,
            );

            this.incomingCallAccepted = false;

            // Release the offer so the patient isn't left waiting.
            this.postJson("/api/calls/inbound/decline", {
                pstnCallId: pstnCallId,
                doctorId: this.doctorId,
            });

            $(this.selectors.callStatus).text(
                error.responseJSON?.message
                    ? "Call no longer available"
                    : "Call failed",
            );

            this.scheduleCallCleanup(1500);
        }
    };

    this.clearIncomingConnectTimer = function () {
        clearTimeout(this.incomingConnectTimer);

        this.incomingConnectTimer = null;
    };

    /*
     * ----------------------------------------
     * REMOTE STREAM (called by code.js)
     * ----------------------------------------
     */

    this.handleInboundStreamAvailable = async function (streamInfo) {
        if (!this.incomingCallAccepted) {
            console.warn("Inbound stream arrived before Accept. Ignored.");

            return;
        }

        console.log("Remote stream belongs to the incoming PSTN call.");

        this.incomingStreamInfo = streamInfo;

        try {
            if (
                window.bandwidthRtc &&
                typeof window.bandwidthRtc.acceptStream === "function"
            ) {
                await window.bandwidthRtc.acceptStream(streamInfo);
            }
        } catch (error) {
            console.error("Failed to accept BRTC incoming stream:", error);

            this.postJson("/api/calls/inbound/end", {
                pstnCallId: this.incomingPstnCallId,
                doctorId: this.doctorId,
            });

            this.handleRemoteHangup("Call failed");

            return;
        }

        this.incomingBrtcConnected = true;

        this.clearIncomingConnectTimer();

        await this.attachRemoteAudio(streamInfo);

        this.activePatient = this.incomingPatient || {
            id: this.incomingPatientId || "INCOMING",
            name: "Patient",
            phoneNumber: this.incomingFrom || "Incoming call",
        };

        $(this.selectors.callPatientName).text(this.activePatient.name);
        $(this.selectors.callPatientNumber).text(
            this.activePatient.phoneNumber,
        );
        $(this.selectors.callStatus).text("Connected");
        $(this.selectors.callDuration).text("00:00");

        $(this.selectors.incomingCallControls).addClass("d-none");
        $(this.selectors.callRingingIndicator).addClass("d-none");
        $(this.selectors.activeCallControls).removeClass("d-none");

        this.stopIncomingRingtone();

        this.setCallWindowMinimized(true);

        this.startCallTimer();

        console.log("Incoming PSTN call connected to BRTC.");
    };

    /*
     * ----------------------------------------
     * DECLINE
     * ----------------------------------------
     */

    this.declineIncomingCall = async function () {
        if (!this.incomingCallActive) {
            console.warn("No incoming call is waiting.");

            return;
        }

        const pstnCallId = this.incomingPstnCallId;

        console.log("Declining incoming PSTN call:", pstnCallId);

        this.stopIncomingRingtone();
        this.stopIncomingAttentionAlert();

        $(this.selectors.incomingCallControls).addClass("d-none");
        $(this.selectors.callRingingIndicator).addClass("d-none");
        $(this.selectors.callStatus).text("Call declined");

        if (pstnCallId) {
            try {
                const response = await this.postJson(
                    "/api/calls/inbound/decline",
                    {
                        pstnCallId: pstnCallId,
                        doctorId: this.doctorId,
                    },
                );

                console.log("Inbound call decline response:", response);
            } catch (error) {
                // Expected race: the call may have already been ended by
                // the OS notification's Decline button, another open tab,
                // or the patient hanging up. That's not a real failure —
                // the UI already cleared above either way, so just log it
                // quietly instead of raising a console error.
                const alreadyHandled =
                    error.status === 409 &&
                    error.responseJSON?.message === "Call is not ringing";

                if (alreadyHandled) {
                    console.log(
                        "Call was already declined/ended elsewhere:",
                        pstnCallId,
                    );
                } else {
                    console.error(
                        "Failed to decline incoming PSTN call:",
                        error.responseJSON || error.responseText || error,
                    );
                }
            }
        }

        this.incomingCallAccepted = false;

        this.scheduleCallCleanup(800);
    };

    /*
     * Called when the call was already declined elsewhere (the OS
     * notification's Decline button, another open tab, etc.) — this
     * only clears THIS tab's ringing UI, it never calls the decline API
     * again (that call has already ended on the server).
     */
    this.handleExternalDecline = function () {
        if (!this.incomingCallActive) {
            return; // this tab was never showing the ringing UI
        }

        console.log("Call already declined elsewhere — clearing UI.");

        this.stopIncomingRingtone();
        this.stopIncomingAttentionAlert();

        $(this.selectors.incomingCallControls).addClass("d-none");
        $(this.selectors.callRingingIndicator).addClass("d-none");
        $(this.selectors.callStatus).text("Call declined");

        this.incomingCallAccepted = false;

        this.scheduleCallCleanup(800);
    };

    /*
     * ----------------------------------------
     * PATIENT HUNG UP / CALL CANCELLED
     * ----------------------------------------
     */

    this.handleIncomingCallCancelled = function (eventData) {
        const data = this.parseEventData(eventData);

        if (
            !data ||
            !this.incomingPstnCallId ||
            data.pstnCallId !== this.incomingPstnCallId
        ) {
            return;
        }

        this.stopIncomingAttentionAlert();

        this.handleRemoteHangup(
            data.reason === "missed" ? "Missed call" : "Call cancelled",
        );
    };

    this.handleIncomingCallEnded = function (eventData) {
        const data = this.parseEventData(eventData);

        if (
            !data ||
            !this.incomingPstnCallId ||
            data.pstnCallId !== this.incomingPstnCallId
        ) {
            return;
        }

        this.stopIncomingAttentionAlert();

        this.handleRemoteHangup(
            this.incomingBrtcConnected ? "Call ended" : "Caller hung up",
        );
    };

    /*
     * ----------------------------------------
     * DOCTOR ENDS INBOUND CALL (called by code.js endCall)
     * ----------------------------------------
     */

    this.endInboundCall = async function () {
        const pstnCallId = this.incomingPstnCallId;

        if (!pstnCallId) {
            return;
        }

        const wasAccepted =
            this.incomingCallAccepted || Boolean(this.activePatient);

        const url = wasAccepted
            ? "/api/calls/inbound/end"
            : "/api/calls/inbound/decline";

        const doctorSession = this.getDoctorSession();

        try {
            const response = await this.postJson(url, {
                pstnCallId: pstnCallId,
                doctorId: this.doctorId,
                endpointId: doctorSession ? doctorSession.endpointId : null,
            });

            console.log("Inbound call ended by doctor:", response);
        } catch (error) {
            console.error(
                "Failed to end inbound call:",
                error.responseJSON || error.responseText || error,
            );
        }
    };

    /*
     * ----------------------------------------
     * TAB CLOSING (called by code.js)
     * ----------------------------------------
     */

    this.sendInboundExitBeacon = function (doctorSession) {
        if (!this.incomingPstnCallId) {
            return;
        }

        const wasAccepted =
            this.incomingCallAccepted || Boolean(this.activePatient);

        const url = wasAccepted
            ? "/api/calls/inbound/end"
            : "/api/calls/inbound/decline";

        const payload = JSON.stringify({
            pstnCallId: this.incomingPstnCallId,
            doctorId: this.doctorId,
            endpointId: doctorSession.endpointId,
        });

        const beaconSent = navigator.sendBeacon(
            url,
            new Blob([payload], { type: "application/json" }),
        );

        console.log("Inbound call end beacon sent:", beaconSent);
    };

    /*
     * ----------------------------------------
     * RINGTONE
     * ----------------------------------------
     */

    this.startIncomingRingtone = function () {
        const ringtone = $(this.selectors.inboundRingtone)[0];

        if (!ringtone) {
            console.warn("Incoming ringtone element not found.");

            return;
        }

        ringtone.currentTime = 0;

        ringtone.play().catch(function (error) {
            console.warn("Unable to start incoming ringtone:", error);
        });
    };

    this.stopIncomingRingtone = function () {
        const ringtone = $(this.selectors.inboundRingtone)[0];

        if (!ringtone) {
            return;
        }

        ringtone.pause();

        ringtone.currentTime = 0;
    };

    /*
     * ----------------------------------------
     * RESET (called by code.js finishCallCleanup)
     * ----------------------------------------
     */

    this.resetInboundState = function () {
        this.clearIncomingConnectTimer();
        this.stopIncomingAttentionAlert();

        this.incomingPatient = null;
        this.incomingPatientId = null;
        this.incomingPstnCallId = null;
        this.incomingFrom = null;
        this.incomingTo = null;
        this.incomingStreamInfo = null;
        this.incomingCallActive = false;
        this.incomingCallAccepted = false;
        this.incomingBrtcConnected = false;
        this.inboundCallActive = false;
    };

    /*
     * ----------------------------------------
     * INBOUND UI EVENTS
     * ----------------------------------------
     */

    this.bindInboundEvents = function () {
        this.initInboundQueueUi();
        this.initCallChannelListener();

        $(this.selectors.acceptIncomingCallButton).on(
            "click",
            function () {
                this.acceptIncomingCall();
            }.bind(this),
        );

        $(this.selectors.declineIncomingCallButton).on(
            "click",
            function () {
                this.declineIncomingCall();
            }.bind(this),
        );

        $(this.selectors.openIncomingPipButton).on(
            "click",
            function () {
                this.openCallPictureInPicture();
            }.bind(this),
        );

        // Separate from the button clicks above — this catches the
        // "Accept" tap coming from the OS-level notification (via the
        // service worker's notificationclick handler), which has no
        // button in the page's own DOM to attach a click listener to.
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.addEventListener(
                "message",
                function (event) {
                    if (event.data?.type === "INBOUND_CALL_ACCEPT") {
                        this.acceptIncomingCall();
                    } else if (event.data?.type === "INBOUND_CALL_DECLINED") {
                        // The notification's own Decline button already
                        // told the server to end the call — just clear
                        // this tab's ringing UI, don't call the decline
                        // API again (it would fail with "Call is not
                        // ringing" since the call is already gone).
                        this.handleExternalDecline();
                    }
                }.bind(this),
            );
        }
    };
};