const bandwidthVoicePoc = function () {
    /*
     * ----------------------------------------
     * SELECTORS
     * ----------------------------------------
     */

    this.backendUrl = "http://localhost:3000";

    this.selectors = {
        loginScreen: "#login_screen",
        appScreen: "#app_screen",
        loginButton: "#btn_login",
        loginError: "#login_error",
        logoutButton: "#btn_logout",
        doctorStatus: "#doctor_status",
        patientList: "#patient_list",
        activeCallWindow: "#active_call_window",
        activeCallControls: "#active_call_controls",
        callWindowHeader: "#call_window_header",
        callWindowBody: "#call_window_body",
        minimizeCallButton: "#btn_minimize_call",
        popoutCallButton: "#btn_popout_call",
        closeCallButton: "#btn_close_call",
        muteCallButton: "#btn_mute_call",
        speakerCallButton: "#btn_speaker_call",
        endCallButton: "#btn_end_call",
        callPatientName: "#call_patient_name",
        callPatientNumber: "#call_patient_number",
        callStatus: "#call_status",
        callDuration: "#call_duration",
        remoteAudio: "#remote_audio",
        doctorId: "#doctor_id",
        loggedInDoctor: "#logged_in_doctor",
        incomingCallControls: "#incoming_call_controls",
        openIncomingPipButton: "#btn_open_incoming_pip",
        acceptIncomingCallButton: "#btn_accept_incoming_call",
        declineIncomingCallButton: "#btn_decline_incoming_call",
        callRingingIndicator: "#call_ringing_indicator",
        inboundRingtone: "#inbound_ringtone",
    };

    /*
     * ----------------------------------------
     * PATIENT DATA
     * ----------------------------------------
     */

    this.patients = [
        { id: "PT001", name: "Humworld Testing", phoneNumber: "+17346660002" },
        { id: "PT002", name: "Bot testing", phoneNumber: "+18042221111" },
        { id: "PT003", name: "Patient 003", phoneNumber: "" },
    ];

    this.activePatient = null;
    this.doctorId = null;
    this.callTimer = null;
    this.callSeconds = 0;
    this.isMuted = false;
    this.isSpeakerEnabled = false;
    this.isCallWindowMinimized = false;
    this.pictureInPictureWindow = null;
    this.pictureInPictureObserver = null;
    this.isDragging = false;
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;
    this.isCallEnding = false;
    this.isPageExiting = false;
    this.microphoneStream = null;
    this.publishedMicrophoneStream = null;

    /*
     * ----------------------------------------
     * INCOMING CALL STATE
     * ----------------------------------------
     */

    this.incomingStreamInfo = null;
    this.incomingCallActive = false;
    this.incomingCallAccepted = false;
    this.incomingPstnCallId = null;
    this.incomingPatientId = null;
    this.incomingPatient = null;
    this.incomingFrom = null;
    this.incomingTo = null;

    /*
     * ----------------------------------------
     * DOCTOR SSE STATE
     * ----------------------------------------
     */

    this.doctorEventSource = null;

    /*
     * ----------------------------------------
     * BRTC EVENTS
     * ----------------------------------------
     */

    this.bindBrtcEvents = function () {
        if (!window.bandwidthRtc) {
            console.error("BandwidthRtc instance is not available.");
            return;
        }

        /*
         * ----------------------------------------
         * REMOTE STREAM AVAILABLE
         * ----------------------------------------
         */

        /*
         * ----------------------------------------
         * REMOTE STREAM AVAILABLE
         * ----------------------------------------
         */

        window.bandwidthRtc.onStreamAvailable(
            async function (streamInfo) {
                console.log("=================================");
                console.log("BRTC onStreamAvailable FIRED");
                console.log("Stream info:", streamInfo);
                console.log(
                    "Media stream:",
                    streamInfo ? streamInfo.mediaStream : null,
                );
                console.log("=================================");

                if (!streamInfo) {
                    console.warn("Bandwidth BRTC stream information is empty.");
                    return;
                }

                /*
                 * ----------------------------------------
                 * OUTBOUND CALL
                 * ----------------------------------------
                 */

                if (this.activePatient && !this.incomingCallActive) {
                    console.log(
                        "Remote stream belongs to the active outbound call.",
                    );

                    this.attachRemoteAudio(streamInfo);

                    $(this.selectors.callStatus).text("Connected");

                    return;
                }

                /*
                 * ----------------------------------------
                 * INCOMING CALL
                 * ----------------------------------------
                 */

                if (this.incomingCallActive) {
                    console.log(
                        "Remote stream belongs to the incoming PSTN call.",
                    );

                    this.incomingStreamInfo = streamInfo;

                    /*
                     * ----------------------------------------
                     * ACCEPT ACTUAL BRTC STREAM
                     * ----------------------------------------
                     *
                     * The doctor already accepted the PSTN call
                     * through /api/calls/inbound/accept.
                     *
                     * The BRTC stream now exists, so this is the
                     * correct point to accept the actual stream.
                     */

                    try {
                        if (
                            window.bandwidthRtc &&
                            typeof window.bandwidthRtc.acceptStream ===
                                "function"
                        ) {
                            await window.bandwidthRtc.acceptStream(streamInfo);

                            console.log("BRTC incoming stream accepted.");
                        }
                    } catch (error) {
                        console.error(
                            "Failed to accept BRTC incoming stream:",
                            error,
                        );

                        $(this.selectors.callStatus).text("Call failed");

                        setTimeout(
                            function () {
                                this.finishCallCleanup();
                            }.bind(this),
                            1500,
                        );

                        return;
                    }

                    this.incomingCallAccepted = true;

                    this.attachRemoteAudio(streamInfo);

                    this.activePatient = this.incomingPatient || {
                        id: this.incomingPatientId || "INCOMING",
                        name: "Patient",
                        phoneNumber: this.incomingFrom || "Incoming call",
                    };

                    $(this.selectors.callPatientName).text(
                        this.activePatient.name,
                    );

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
                }
            }.bind(this),
        );

        /*
         * ----------------------------------------
         * REMOTE STREAM UNAVAILABLE
         * ----------------------------------------
         */

        window.bandwidthRtc.onStreamUnavailable(
            function (streamInfo) {
                console.log("BRTC stream unavailable:", streamInfo);

                if (this.incomingCallActive) {
                    console.log("Incoming BRTC stream was released.");

                    this.stopIncomingRingtone();

                    $(this.selectors.callStatus).text("Call ended");

                    $(this.selectors.incomingCallControls).addClass("d-none");

                    $(this.selectors.callRingingIndicator).addClass("d-none");

                    this.stopMicrophone().then(
                        function () {
                            setTimeout(
                                function () {
                                    this.finishCallCleanup();
                                }.bind(this),
                                800,
                            );
                        }.bind(this),
                    );

                    return;
                }

                if (this.activePatient) {
                    console.log("Active outbound BRTC stream was released.");

                    $(this.selectors.callStatus).text("Call ended");

                    this.stopCallTimer();

                    this.stopMicrophone().then(
                        function () {
                            setTimeout(
                                function () {
                                    this.finishCallCleanup();
                                }.bind(this),
                                800,
                            );
                        }.bind(this),
                    );
                }
            }.bind(this),
        );

        /*
         * ----------------------------------------
         * BRTC READY
         * ----------------------------------------
         */

        window.bandwidthRtc.onReady(function (metadata) {
            console.log("BRTC endpoint is ready.");
            console.log("BRTC ready metadata:", metadata);
        });

        /*
         * ----------------------------------------
         * DTMF
         * ----------------------------------------
         */

        window.bandwidthRtc.onDtmfSent(function (event) {
            console.log("DTMF sent:", event);
        });
    };

    /*
     * ----------------------------------------
     * ATTACH REMOTE AUDIO
     * ----------------------------------------
     */

    this.attachRemoteAudio = async function (streamInfo) {
        if (!streamInfo || !streamInfo.mediaStream) {
            console.warn(
                "Unable to attach remote audio. Media stream unavailable.",
            );

            return;
        }

        const remoteAudio = $(this.selectors.remoteAudio)[0];

        if (!remoteAudio) {
            console.warn("Remote audio element not found.");

            return;
        }

        console.log("Attaching remote MediaStream:", streamInfo.mediaStream);

        remoteAudio.srcObject = streamInfo.mediaStream;

        try {
            await remoteAudio.play();

            console.log("Remote audio playback started.");
        } catch (error) {
            console.warn("Remote audio autoplay failed:", error);
        }
    };

    /*
     * ----------------------------------------
     * DOCTOR SSE CONNECTION
     * ----------------------------------------
     */

    this.connectDoctorEvents = function (doctorId) {
        if (!doctorId) {
            console.warn("Doctor ID is required to connect to doctor events.");

            return;
        }

        this.disconnectDoctorEvents();

        const eventsUrl =
            `${this.backendUrl}/api/doctor/events?doctorId=` +
            encodeURIComponent(doctorId);

        console.log("Connecting doctor SSE:", eventsUrl);

        try {
            this.doctorEventSource = new EventSource(eventsUrl);

            this.doctorEventSource.onopen = function () {
                console.log("Doctor SSE connection established.");
            };

            this.doctorEventSource.onerror = function (error) {
                console.error("Doctor SSE connection error:", error);
            };

            /*
             * ----------------------------------------
             * DEFAULT MESSAGE EVENT
             * ----------------------------------------
             */

            this.doctorEventSource.onmessage = function (event) {
                console.log("Doctor SSE message:", event.data);

                this.handleDoctorEventData(event.data);
            }.bind(this);

            /*
             * ----------------------------------------
             * NAMED EVENT
             * ----------------------------------------
             *
             * Supports:
             *
             * event: incomingPstnCall
             * data: {...}
             */

            this.doctorEventSource.addEventListener(
                "incomingPstnCall",
                function (event) {
                    console.log(
                        "Doctor SSE incomingPstnCall event:",
                        event.data,
                    );

                    this.handleDoctorEventData(event.data);
                }.bind(this),
            );

            this.doctorEventSource.addEventListener(
                "incomingPstnCallCancelled",
                function (event) {
                    console.log("Incoming PSTN call cancelled:", event.data);

                    this.handleIncomingCallCancelled(event.data);
                }.bind(this),
            );

            this.doctorEventSource.addEventListener(
                "incomingPstnCallEnded",
                function (event) {
                    console.log("Incoming PSTN call ended:", event.data);

                    this.handleIncomingCallEnded(event.data);
                }.bind(this),
            );
        } catch (error) {
            console.error("Unable to create doctor SSE connection:", error);
        }
    };

    /*
     * ----------------------------------------
     * DISCONNECT DOCTOR SSE
     * ----------------------------------------
     */

    this.disconnectDoctorEvents = function () {
        if (this.doctorEventSource) {
            console.log("Closing doctor SSE connection.");

            this.doctorEventSource.close();

            this.doctorEventSource = null;
        }
    };

    /*
     * ----------------------------------------
     * HANDLE DOCTOR SSE DATA
     * ----------------------------------------
     */

    this.handleDoctorEventData = function (eventData) {
        if (!eventData) {
            return;
        }

        let data = eventData;

        if (typeof eventData === "string") {
            try {
                data = JSON.parse(eventData);
            } catch (error) {
                console.warn("Unable to parse doctor SSE event:", eventData);

                return;
            }
        }

        if (!data || !data.type) {
            console.warn("Doctor SSE event does not contain a type:", data);

            return;
        }

        console.log("Processed doctor event:", data);

        switch (data.type) {
            case "incomingPstnCall":
                this.handleIncomingPstnCall(data);
                break;

            case "incomingPstnCallCancelled":
                this.handleIncomingCallCancelled(data);
                break;

            default:
                console.log("Unhandled doctor event type:", data.type);
                break;
        }
    };

    /*
     * ----------------------------------------
     * HANDLE INCOMING PSTN CALL
     * ----------------------------------------
     */

    this.handleIncomingPstnCall = function (callData) {
        console.log("Incoming PSTN call notification received:", callData);

        if (!callData || !callData.pstnCallId) {
            console.warn(
                "Incoming PSTN notification does not contain pstnCallId.",
            );

            return;
        }

        /*
         * If another call is already active,
         * do not replace the active call.
         */

        if (this.activePatient) {
            console.warn(
                "A call is already active. Ignoring incoming PSTN call.",
            );

            return;
        }

        /*
         * If another incoming call is already ringing,
         * do not replace it.
         */

        if (this.incomingCallActive && this.incomingPstnCallId) {
            console.warn("Another incoming PSTN call is already ringing.");

            return;
        }

        this.incomingPstnCallId = callData.pstnCallId;

        this.incomingPatientId = callData.patientId || null;

        this.incomingFrom = callData.from || null;

        this.incomingTo = callData.to || null;

        /*
         * ----------------------------------------
         * REGISTERED PATIENT
         * ----------------------------------------
         */

        if (this.incomingPatientId) {
            const patient = this.getPatient(this.incomingPatientId);

            if (patient) {
                this.incomingPatient = {
                    id: patient.id,
                    name: patient.name,
                    phoneNumber: this.incomingFrom || patient.phoneNumber,
                };
            } else {
                this.incomingPatient = {
                    id: this.incomingPatientId,
                    name: "Patient",
                    phoneNumber: this.incomingFrom || "Incoming call",
                };
            }
        } else {
            /*
             * ----------------------------------------
             * UNKNOWN CALLER
             * ----------------------------------------
             */

            this.incomingPatient = {
                id: "UNKNOWN",
                name: "Unknown caller",
                phoneNumber: this.incomingFrom || "Incoming call",
            };
        }

        this.incomingCallActive = true;
        this.incomingCallAccepted = false;

        this.incomingStreamInfo = null;

        /*
         * ----------------------------------------
         * SHOW UI IMMEDIATELY
         * ----------------------------------------
         *
         * IMPORTANT:
         *
         * We do NOT wait for onStreamAvailable().
         *
         * The backend is waiting for the doctor
         * to accept before it executes <Connect>.
         */

        this.showIncomingCall(callData);
    };

    /*
     * ----------------------------------------
     * HANDLE INCOMING CALL CANCELLED
     * ----------------------------------------
     */

    this.handleIncomingCallCancelled = function (eventData) {
        let data = eventData;

        if (typeof eventData === "string") {
            try {
                data = JSON.parse(eventData);
            } catch (error) {
                console.warn("Unable to parse cancellation event:", eventData);

                return;
            }
        }

        if (
            !this.incomingPstnCallId ||
            !data ||
            data.pstnCallId !== this.incomingPstnCallId
        ) {
            return;
        }

        console.log("Current incoming call was cancelled by another doctor.");

        this.stopIncomingRingtone();

        $(this.selectors.callStatus).text("Call answered by another doctor");

        $(this.selectors.incomingCallControls).addClass("d-none");

        $(this.selectors.callRingingIndicator).addClass("d-none");

        setTimeout(
            function () {
                this.finishCallCleanup();
            }.bind(this),
            1200,
        );
    };

    this.handleIncomingCallEnded = function (eventData) {
        let data = eventData;

        if (typeof eventData === "string") {
            try {
                data = JSON.parse(eventData);
            } catch (error) {
                console.warn(
                    "Unable to parse incoming call ended event:",
                    eventData,
                );

                return;
            }
        }

        if (
            !this.incomingPstnCallId ||
            !data ||
            data.pstnCallId !== this.incomingPstnCallId
        ) {
            return;
        }

        console.log("PSTN caller disconnected.");

        this.stopIncomingRingtone();

        $(this.selectors.callStatus).text("Call ended");

        $(this.selectors.incomingCallControls).addClass("d-none");

        $(this.selectors.callRingingIndicator).addClass("d-none");

        setTimeout(
            function () {
                this.finishCallCleanup();
            }.bind(this),
            800,
        );
    };
    /*
     * ----------------------------------------
     * SHOW INCOMING CALL
     * ----------------------------------------
     */

    this.showIncomingCall = function (callData) {
        console.log("Showing incoming call UI.");

        this.showCallWindow(false);

        const patient = this.incomingPatient || {
            id: this.incomingPatientId || "UNKNOWN",
            name: "Unknown caller",
            phoneNumber: this.incomingFrom || "Incoming call",
        };

        $(this.selectors.callPatientName).text(patient.name);

        $(this.selectors.callPatientNumber).text(patient.phoneNumber);

        $(this.selectors.callStatus).text("Incoming call");

        $(this.selectors.callDuration).text("00:00");

        $(this.selectors.callRingingIndicator).removeClass("d-none");

        $(this.selectors.incomingCallControls).removeClass("d-none");

        $(this.selectors.activeCallControls).addClass("d-none");

        this.startIncomingRingtone();

        console.log("Incoming call UI displayed.");
    };

    /*
     * ----------------------------------------
     * ACCEPT INCOMING CALL
     * ----------------------------------------
     */

    this.acceptIncomingCall = async function () {
        if (!this.incomingCallActive) {
            console.warn("No incoming call is waiting.");

            return;
        }

        if (!this.incomingPstnCallId) {
            console.warn("Incoming PSTN call ID is unavailable.");

            return;
        }

        const doctorSession = this.getDoctorSession();

        if (!doctorSession || !doctorSession.endpointId || !this.doctorId) {
            console.error("Doctor BRTC session is unavailable.");

            return;
        }

        console.log("Accepting incoming PSTN call:", this.incomingPstnCallId);

        /*
         * ----------------------------------------
         * DOCUMENT PIP
         * ----------------------------------------
         */

        this.openCallPictureInPicture();

        try {
            this.stopIncomingRingtone();

            $(this.selectors.callStatus).text("Connecting...");

            $(this.selectors.incomingCallControls).addClass("d-none");

            $(this.selectors.callRingingIndicator).addClass("d-none");

            /*
             * ----------------------------------------
             * TELL BACKEND DOCTOR ACCEPTED
             * ----------------------------------------
             */

            const response = await $.ajax({
                url: `${this.backendUrl}/api/calls/inbound/accept`,
                type: "POST",
                contentType: "application/json",
                data: JSON.stringify({
                    pstnCallId: this.incomingPstnCallId,
                    doctorId: this.doctorId,
                    endpointId: doctorSession.endpointId,
                }),
            });

            console.log("Inbound call accept response:", response);

            if (!response || !response.success) {
                throw new Error(
                    response?.message || "Backend rejected the incoming call.",
                );
            }

            this.incomingCallAccepted = true;

            /*
             * ----------------------------------------
             * DO NOT CALL acceptStream() HERE
             * ----------------------------------------
             *
             * The backend acceptance above causes
             * the Voice call to be redirected to:
             *
             * <Connect><Endpoint>
             *
             * BRTC will then fire onStreamAvailable().
             */

            console.log("Doctor accepted PSTN call.");

            console.log("Waiting for BRTC onStreamAvailable...");

            $(this.selectors.callStatus).text("Connecting to caller...");
        } catch (error) {
            console.error(
                "Failed to accept incoming PSTN call:",
                error.responseJSON || error.responseText || error,
            );

            this.stopIncomingRingtone();

            this.incomingCallAccepted = false;

            $(this.selectors.callStatus).text("Call failed");

            setTimeout(
                function () {
                    this.finishCallCleanup();
                }.bind(this),
                1500,
            );
        }
    };

    /*
     * ----------------------------------------
     * DECLINE INCOMING CALL
     * ----------------------------------------
     */

    this.declineIncomingCall = async function () {
        if (!this.incomingCallActive) {
            console.warn("No incoming call is waiting.");

            return;
        }

        const doctorSession = this.getDoctorSession();

        console.log("Declining incoming PSTN call:", this.incomingPstnCallId);

        this.stopIncomingRingtone();

        try {
            /*
             * ----------------------------------------
             * TELL BACKEND DOCTOR DECLINED
             * ----------------------------------------
             */

            if (this.incomingPstnCallId && doctorSession) {
                const response = await $.ajax({
                    url: `${this.backendUrl}/api/calls/inbound/decline`,
                    type: "POST",
                    contentType: "application/json",
                    data: JSON.stringify({
                        pstnCallId: this.incomingPstnCallId,
                        doctorId: this.doctorId,
                        endpointId: doctorSession.endpointId,
                    }),
                });

                console.log("Inbound call decline response:", response);
            }
        } catch (error) {
            console.error(
                "Failed to decline incoming PSTN call:",
                error.responseJSON || error.responseText || error,
            );
        }

        this.incomingCallAccepted = false;

        $(this.selectors.callStatus).text("Call declined");

        setTimeout(
            function () {
                this.finishCallCleanup();
            }.bind(this),
            800,
        );
    };

    /*
     * ----------------------------------------
     * START INCOMING RINGTONE
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

    /*
     * ----------------------------------------
     * STOP INCOMING RINGTONE
     * ----------------------------------------
     */

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
     * HIDE INCOMING CALL
     * ----------------------------------------
     */

    this.hideIncomingCall = function () {
        $(this.selectors.incomingCallControls).addClass("d-none");

        $(this.selectors.callRingingIndicator).addClass("d-none");

        this.incomingCallActive = false;
        this.incomingCallAccepted = false;
    };

    /*
     * ----------------------------------------
     * WAIT FOR ENDPOINT ELIGIBILITY
     * ----------------------------------------
     */

    this.waitForEndpointEligibility = function (endpointId) {
        return new Promise(function (resolve, reject) {
            const startedAt = Date.now();

            const timeout = 15000;

            const checkStatus = function () {
                $.ajax({
                    url: "/api/doctor/endpoint-status",
                    type: "GET",
                    data: {
                        endpointId: endpointId,
                    },
                })
                    .done(function (response) {
                        if (response.success && response.eligible) {
                            console.log(
                                "BRTC endpoint is eligible:",
                                endpointId,
                            );

                            resolve(response);

                            return;
                        }

                        if (Date.now() - startedAt >= timeout) {
                            reject(
                                new Error(
                                    "BRTC endpoint did not become eligible within 15 seconds.",
                                ),
                            );

                            return;
                        }

                        setTimeout(checkStatus, 500);
                    })
                    .fail(function (xhr) {
                        if (Date.now() - startedAt >= timeout) {
                            reject(
                                new Error(
                                    xhr.responseJSON?.message ||
                                        "Unable to check BRTC endpoint status.",
                                ),
                            );

                            return;
                        }

                        setTimeout(checkStatus, 500);
                    });
            };

            checkStatus();
        });
    };

    /*
     * ----------------------------------------
     * GET DOCTOR SESSION
     * ----------------------------------------
     */

    this.getDoctorSession = function () {
        const sessionData = localStorage.getItem("doctorBrtcSession");

        if (!sessionData) {
            return null;
        }

        try {
            return JSON.parse(sessionData);
        } catch (error) {
            console.error("Invalid doctor session:", error);

            localStorage.removeItem("doctorBrtcSession");

            return null;
        }
    };

    /*
     * ----------------------------------------
     * CHECK SESSION VALIDITY
     * ----------------------------------------
     */

    this.isSessionValid = function (sessionData) {
        if (
            !sessionData ||
            !sessionData.endpointId ||
            !sessionData.token ||
            !sessionData.expirationTimestamp
        ) {
            return false;
        }

        const expirationTime = new Date(
            sessionData.expirationTimestamp,
        ).getTime();

        return expirationTime > Date.now();
    };

    /*
     * ----------------------------------------
     * CREATE DOCTOR SESSION
     * ----------------------------------------
     */

    this.createDoctorSession = function (doctorId) {
        return $.ajax({
            url: "/api/doctor/session",
            method: "POST",
            contentType: "application/json",
            data: JSON.stringify({
                doctorId: doctorId,
            }),
        });
    };

    /*
     * ----------------------------------------
     * SAVE DOCTOR SESSION
     * ----------------------------------------
     */

    this.saveDoctorSession = function (sessionData) {
        localStorage.setItem("doctorBrtcSession", JSON.stringify(sessionData));
    };

    /*
     * ----------------------------------------
     * DELETE DOCTOR ENDPOINT
     * ----------------------------------------
     */

    this.deleteDoctorEndpoint = async function (endpointId) {
        if (!endpointId) {
            return;
        }

        console.log("Deleting BRTC endpoint:", endpointId);

        try {
            const response = await $.ajax({
                url: `/api/doctor/endpoint/${encodeURIComponent(endpointId)}`,
                type: "DELETE",
            });

            console.log("BRTC endpoint deletion response:", response);
        } catch (error) {
            if (error.status === 404) {
                console.log("BRTC endpoint was already deleted:", endpointId);
            } else {
                console.error(
                    "Failed to delete BRTC endpoint:",
                    error.responseJSON || error.responseText || error,
                );
            }
        }
    };

    /*
     * ----------------------------------------
     * DELETE STORED DOCTOR ENDPOINT
     * ----------------------------------------
     */

    this.deleteStoredDoctorEndpoint = async function () {
        const sessionData = this.getDoctorSession();

        if (!sessionData || !sessionData.endpointId) {
            localStorage.removeItem("doctorBrtcSession");

            return;
        }

        const endpointId = sessionData.endpointId;

        console.log("Old doctor endpoint found:", endpointId);

        console.log(
            "Deleting old doctor endpoint before creating a new one...",
        );

        await this.deleteDoctorEndpoint(endpointId);

        localStorage.removeItem("doctorBrtcSession");

        console.log("Old doctor endpoint removed from localStorage.");
    };

    /*
     * ----------------------------------------
     * LOGIN DOCTOR
     * ----------------------------------------
     */

    this.loginDoctor = function () {
        this.doctorId = $(this.selectors.doctorId).val();

        if (!this.doctorId) {
            this.showLoginError("Please select a doctor.");

            return;
        }

        $(this.selectors.loginError).addClass("d-none").text("");

        $(this.selectors.loginButton)
            .prop("disabled", true)
            .text("Connecting...");

        console.log("Starting doctor login.");

        this.deleteStoredDoctorEndpoint()
            .then(
                function () {
                    console.log("Creating new BRTC doctor endpoint.");

                    return this.createDoctorSession(this.doctorId);
                }.bind(this),
            )
            .then(
                function (response) {
                    if (!response.success) {
                        throw new Error(
                            response.message ||
                                "Unable to create doctor endpoint.",
                        );
                    }

                    const sessionData = {
                        doctorId: response.doctorId,
                        endpointId: response.endpointId,
                        token: response.token,
                        expirationTimestamp: response.expirationTimestamp,
                    };

                    this.saveDoctorSession(sessionData);

                    console.log("New doctor endpoint created.");

                    console.log("Endpoint ID:", sessionData.endpointId);

                    console.log(
                        "Endpoint expires:",
                        sessionData.expirationTimestamp,
                    );

                    return this.connectDoctor(sessionData);
                }.bind(this),
            )
            .catch(
                function (error) {
                    console.error("Doctor login failed:", error);

                    this.showLoginError(
                        error.message || "Unable to connect to Bandwidth.",
                    );
                }.bind(this),
            );
    };

    /*
     * ----------------------------------------
     * CONNECT DOCTOR TO BRTC
     * ----------------------------------------
     */

    this.connectDoctor = async function (sessionData) {
        try {
            console.log("Connecting BRTC endpoint:", sessionData.endpointId);

            await window.bandwidthRtc.connect({
                endpointToken: sessionData.token,
            });

            console.log("BRTC connection successful.");

            console.log("Publishing doctor microphone to BRTC...");

            const publishedStream = await window.bandwidthRtc.publish({
                audio: true,
                video: false,
            });

            this.publishedMicrophoneStream = publishedStream;

            console.log("Doctor microphone published successfully.");

            console.log("Published BRTC stream:", publishedStream);

            this.showApplicationScreen();

            /*
             * ----------------------------------------
             * CONNECT DOCTOR SSE
             * ----------------------------------------
             */

            this.connectDoctorEvents(sessionData.doctorId);

            return true;
        } catch (error) {
            console.error("BRTC connection failed:", error);

            await this.stopMicrophone();

            this.disconnectDoctorEvents();

            this.showLoginError(
                "Unable to connect to Bandwidth voice service.",
            );

            return false;
        }
    };

    /*
     * ----------------------------------------
     * START MICROPHONE
     * ----------------------------------------
     */

    this.startMicrophone = async function () {
        try {
            console.log("Starting microphone...");

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: false,
            });

            this.microphoneStream = stream;

            console.log("Microphone stream created.");

            if (!window.bandwidthRtc) {
                throw new Error("BandwidthRtc instance is not available.");
            }

            const publishedStream = await window.bandwidthRtc.publish(stream);

            this.publishedMicrophoneStream = publishedStream;

            console.log("Doctor microphone published successfully.");

            console.log("Published stream:", publishedStream);

            return true;
        } catch (error) {
            console.error("Failed to start microphone:", error);

            await this.stopMicrophone();

            return false;
        }
    };

    /*
     * ----------------------------------------
     * STOP MICROPHONE
     * ----------------------------------------
     */

    this.stopMicrophone = async function () {
        console.log("Stopping microphone...");

        if (window.bandwidthRtc && this.publishedMicrophoneStream) {
            try {
                await window.bandwidthRtc.unpublish(
                    this.publishedMicrophoneStream,
                );

                console.log("Doctor microphone unpublished.");
            } catch (error) {
                console.error("Failed to unpublish microphone:", error);
            }
        }

        if (this.microphoneStream) {
            this.microphoneStream.getTracks().forEach(function (track) {
                track.stop();
            });

            console.log("Browser microphone tracks stopped.");
        }

        this.microphoneStream = null;

        this.publishedMicrophoneStream = null;
    };

    /*
     * ----------------------------------------
     * SHOW LOGIN ERROR
     * ----------------------------------------
     */

    this.showLoginError = function (message) {
        $(this.selectors.loginError).removeClass("d-none").text(message);

        $(this.selectors.loginButton).prop("disabled", false).text("Login");
    };

    /*
     * ----------------------------------------
     * SHOW APPLICATION SCREEN
     * ----------------------------------------
     */

    this.showApplicationScreen = function () {
        $(this.selectors.loginScreen).hide();

        $(this.selectors.appScreen).show();

        $(this.selectors.doctorStatus)
            .removeClass("text-bg-warning text-bg-danger")
            .addClass("text-bg-success")
            .text("Connected");

        $(this.selectors.loggedInDoctor).text(this.doctorId);

        $(this.selectors.loginButton).prop("disabled", false).text("Login");

        this.renderPatients();
    };

    /*
     * ----------------------------------------
     * RENDER PATIENTS
     * ----------------------------------------
     */

    this.renderPatients = function () {
        const $patientList = $(this.selectors.patientList);

        $patientList.empty();

        $.each(
            this.patients,
            function (index, patient) {
                const patientHtml = `
          <div class="col-12 col-md-6 col-lg-4">
            <div class="patient-card p-3 h-100">
              <div class="d-flex align-items-center justify-content-between">
                <div>
                  <div class="patient-name">${patient.name}</div>
                  <div class="patient-phone">${patient.phoneNumber}</div>
                </div>

                <span class="material-symbols-outlined text-success">
                  person
                </span>
              </div>

              <button type="button" class="btn btn-success w-100 mt-3 btn-call-patient" data-patient-id="${patient.id}">
                <span class="material-symbols-outlined align-middle" style="font-size:18px;">
                  call
                </span>
                Call
              </button>
            </div>
          </div>
        `;

                $patientList.append(patientHtml);
            }.bind(this),
        );
    };

    /*
     * ----------------------------------------
     * FIND PATIENT
     * ----------------------------------------
     */

    this.getPatient = function (patientId) {
        const matchingPatients = $.grep(this.patients, function (patient) {
            return patient.id === patientId;
        });

        return matchingPatients[0];
    };

    /*
     * ----------------------------------------
     * CALL PATIENT
     * ----------------------------------------
     *
     * EXISTING OUTBOUND FLOW
     * ----------------------------------------
     */

    this.callPatient = async function (patient) {
        const doctorSession = this.getDoctorSession();

        if (!doctorSession || !this.isSessionValid(doctorSession)) {
            alert("Doctor session has expired. Please login again.");

            return;
        }

        if (this.activePatient) {
            console.warn("A call is already active.");

            return;
        }

        if (this.incomingCallActive) {
            console.warn("An incoming call is already active.");

            return;
        }

        if (this.isCallEnding) {
            console.warn("Previous BRTC call is still ending.");

            return;
        }

        this.openCallPictureInPicture();

        this.activePatient = patient;

        $(this.selectors.callPatientName).text(patient.name);

        $(this.selectors.callPatientNumber).text(patient.phoneNumber);

        $(this.selectors.callStatus).text("Preparing call...");

        $(this.selectors.callDuration).text("00:00");

        this.showCallWindow(true);

        try {
            console.log("Starting microphone...");

            $(this.selectors.callStatus).text("Requesting microphone...");

            const microphoneStarted = await this.startMicrophone();

            if (!microphoneStarted) {
                throw new Error("Unable to access microphone.");
            }

            console.log("Microphone started successfully.");

            console.log("Waiting for BRTC endpoint eligibility...");

            $(this.selectors.callStatus).text("Preparing connection...");

            await this.waitForEndpointEligibility(doctorSession.endpointId);

            $(this.selectors.callStatus).text("Calling...");

            console.log(
                "Requesting BRTC outbound connection:",
                patient.phoneNumber,
            );

            await window.bandwidthRtc.requestOutboundConnection(
                patient.phoneNumber,
                window.EndpointType.PHONE_NUMBER,
            );

            console.log("BRTC outbound connection request accepted.");
        } catch (error) {
            console.error("BRTC outbound connection failed:", error);

            await this.handleCallFailure(
                error?.message || "Unable to start the call.",
            );
        }
    };

    /*
     * ----------------------------------------
     * CALL FAILURE
     * ----------------------------------------
     */

    this.handleCallFailure = async function (message) {
        $(this.selectors.callStatus).text("Call failed");

        console.error(message);

        this.stopCallTimer();

        await this.stopMicrophone();

        setTimeout(
            function () {
                this.finishCallCleanup();
            }.bind(this),
            1500,
        );
    };

    /*
     * ----------------------------------------
     * START CALL TIMER
     * ----------------------------------------
     */

    this.startCallTimer = function () {
        this.stopCallTimer();

        this.callSeconds = 0;

        this.callTimer = setInterval(
            function () {
                this.callSeconds++;

                const minutes = Math.floor(this.callSeconds / 60);

                const seconds = this.callSeconds % 60;

                const duration =
                    String(minutes).padStart(2, "0") +
                    ":" +
                    String(seconds).padStart(2, "0");

                $(this.selectors.callDuration).text(duration);
            }.bind(this),
            1000,
        );
    };

    /*
     * ----------------------------------------
     * STOP CALL TIMER
     * ----------------------------------------
     */

    this.stopCallTimer = function () {
        if (this.callTimer) {
            clearInterval(this.callTimer);

            this.callTimer = null;
        }
    };

    /*
     * ----------------------------------------
     * END CALL
     * ----------------------------------------
     */

    this.endCall = async function () {
        if (!this.activePatient) {
            return;
        }

        if (this.isCallEnding) {
            console.warn("Call ending already in progress.");

            return;
        }

        this.isCallEnding = true;

        const doctorSession = this.getDoctorSession();

        const patient = this.activePatient;

        console.log("Ending call:", patient.phoneNumber);

        try {
            if (doctorSession) {
                console.log("Requesting backend to end Voice call...");

                const response = await $.ajax({
                    url: "/api/calls/end",
                    type: "POST",
                    contentType: "application/json",
                    data: JSON.stringify({
                        endpointId: doctorSession.endpointId,
                    }),
                });

                console.log("Bandwidth Voice call ended:", response);
            }
        } catch (error) {
            console.error(
                "Failed to end Bandwidth Voice call:",
                error.responseJSON || error.responseText || error,
            );
        }

        await this.stopMicrophone();

        if (window.bandwidthRtc) {
            try {
                console.log("Requesting BRTC hangup...");

                await window.bandwidthRtc.hangupConnection(
                    patient.phoneNumber,
                    window.EndpointType.PHONE_NUMBER,
                );

                console.log("BRTC connection hangup successful.");
            } catch (error) {
                console.error("BRTC hangup failed:", error);
            }
        }

        this.finishCallCleanup();

        this.isCallEnding = false;
    };

    /*
     * ----------------------------------------
     * FINISH CALL CLEANUP
     * ----------------------------------------
     */

    this.finishCallCleanup = function () {
        this.stopCallTimer();

        this.stopIncomingRingtone();

        if (
            this.pictureInPictureWindow &&
            !this.pictureInPictureWindow.closed
        ) {
            this.pictureInPictureWindow.close();
        }

        const remoteAudio = $(this.selectors.remoteAudio)[0];

        if (remoteAudio) {
            remoteAudio.pause();

            remoteAudio.srcObject = null;
        }

        $(this.selectors.activeCallWindow).removeClass("is-pip").hide();

        $(this.selectors.incomingCallControls).addClass("d-none");

        $(this.selectors.callRingingIndicator).addClass("d-none");

        this.activePatient = null;

        this.incomingPatient = null;

        this.incomingPatientId = null;

        this.incomingPstnCallId = null;

        this.incomingFrom = null;

        this.incomingTo = null;

        this.incomingStreamInfo = null;

        this.incomingCallActive = false;

        this.incomingCallAccepted = false;

        this.isMuted = false;

        this.isSpeakerEnabled = false;

        this.isCallWindowMinimized = false;

        this.resetCallControls();

        console.log("Call frontend state cleaned.");
    };

    /*
     * ----------------------------------------
     * MUTE
     * ----------------------------------------
     */

    this.toggleMute = function () {
        if (!this.activePatient) {
            return;
        }

        this.isMuted = !this.isMuted;

        if (window.bandwidthRtc) {
            try {
                window.bandwidthRtc.setMicEnabled(!this.isMuted);
            } catch (error) {
                console.error("Unable to change microphone state:", error);
            }
        }

        $(this.selectors.muteCallButton).toggleClass(
            "call-control-active",
            this.isMuted,
        );

        $(this.selectors.muteCallButton)
            .find(".material-symbols-outlined")
            .text(this.isMuted ? "mic_off" : "mic");
    };

    /*
     * ----------------------------------------
     * SPEAKER
     * ----------------------------------------
     */

    this.toggleSpeaker = function () {
        if (!this.activePatient) {
            return;
        }

        this.isSpeakerEnabled = !this.isSpeakerEnabled;

        $(this.selectors.speakerCallButton).toggleClass(
            "call-control-active",
            this.isSpeakerEnabled,
        );
    };

    /*
     * ----------------------------------------
     * RESET CALL CONTROLS
     * ----------------------------------------
     */

    this.resetCallControls = function () {
        $(this.selectors.muteCallButton)
            .removeClass("call-control-active")
            .find(".material-symbols-outlined")
            .text("mic");

        $(this.selectors.speakerCallButton).removeClass("call-control-active");

        $(this.selectors.incomingCallControls).addClass("d-none");

        $(this.selectors.callRingingIndicator).addClass("d-none");
    };

    /*
     * ----------------------------------------
     * MINIMIZE CALL WINDOW
     * ----------------------------------------
     */

    this.minimizeCallWindow = function () {
        this.setCallWindowMinimized(!this.isCallWindowMinimized);
    };

    /*
     * ----------------------------------------
     * SET CALL WINDOW MINIMIZED
     * ----------------------------------------
     */

    this.setCallWindowMinimized = function (minimized) {
        this.isCallWindowMinimized = minimized;

        $(this.selectors.activeCallWindow).toggleClass("is-pip", minimized);

        $(this.selectors.minimizeCallButton)
            .attr("title", minimized ? "Expand call" : "Minimize call")
            .attr("aria-label", minimized ? "Expand call" : "Minimize call")
            .find(".material-symbols-outlined")
            .text(minimized ? "open_in_full" : "remove");
    };

    /*
     * ----------------------------------------
     * SHOW CALL WINDOW
     * ----------------------------------------
     */

    this.showCallWindow = function (minimized) {
        this.setCallWindowMinimized(minimized);

        $(this.selectors.activeCallWindow).show();

        if (
            this.pictureInPictureWindow &&
            !this.pictureInPictureWindow.closed
        ) {
            $(this.selectors.activeCallWindow).hide();
        }
    };

    /*
     * ----------------------------------------
     * OPEN PICTURE IN PICTURE
     * ----------------------------------------
     */

    this.openCallPictureInPicture = async function () {
        if (
            this.pictureInPictureWindow &&
            !this.pictureInPictureWindow.closed
        ) {
            this.pictureInPictureWindow.focus();

            return;
        }

        if (!("documentPictureInPicture" in window)) {
            console.info(
                "Document Picture-in-Picture is unavailable; using the in-page call panel.",
            );

            return;
        }

        try {
            const pipWindow =
                await window.documentPictureInPicture.requestWindow({
                    width: 360,
                    height: 250,
                    preferInitialWindowPlacement: true,
                });

            const callWindow = $(this.selectors.activeCallWindow)[0];

            if (!callWindow) {
                pipWindow.close();

                return;
            }

            $("link[rel='stylesheet'], style").each(function () {
                pipWindow.document.head.appendChild(this.cloneNode(true));
            });

            const pipStyle = pipWindow.document.createElement("style");

            pipStyle.textContent = `
                html, body { margin: 0; min-width: 0; background: #f5f7fa; }
                #active_call_window {
                    position: static !important;
                    display: block !important;
                    width: auto !important;
                    min-height: 100vh;
                    border: 0 !important;
                    border-radius: 0 !important;
                    box-shadow: none !important;
                }
            `;

            pipWindow.document.head.appendChild(pipStyle);

            const pipCallWindow = callWindow.cloneNode(true);

            pipWindow.document.body.appendChild(pipCallWindow);

            this.pictureInPictureWindow = pipWindow;

            this.pictureInPictureObserver = new MutationObserver(
                function () {
                    this.syncPictureInPictureCallWindow();
                }.bind(this),
            );

            this.pictureInPictureObserver.observe(callWindow, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
            });

            this.bindPictureInPictureControls();

            $(callWindow).hide();

            pipWindow.addEventListener(
                "pagehide",
                function () {
                    this.restoreCallWindowFromPictureInPicture();
                }.bind(this),
                {
                    once: true,
                },
            );
        } catch (error) {
            console.warn("Unable to open Document Picture-in-Picture:", error);
        }
    };

    /*
     * ----------------------------------------
     * RESTORE CALL WINDOW FROM PIP
     * ----------------------------------------
     */

    this.restoreCallWindowFromPictureInPicture = function () {
        if (this.pictureInPictureObserver) {
            this.pictureInPictureObserver.disconnect();

            this.pictureInPictureObserver = null;
        }

        if (this.activePatient || this.incomingCallActive) {
            $(this.selectors.activeCallWindow).show();
        } else {
            $(this.selectors.activeCallWindow).hide();
        }

        this.pictureInPictureWindow = null;
    };

    /*
     * ----------------------------------------
     * SYNC PIP
     * ----------------------------------------
     */

    this.syncPictureInPictureCallWindow = function () {
        if (
            !this.pictureInPictureWindow ||
            this.pictureInPictureWindow.closed
        ) {
            return;
        }

        const source = $(this.selectors.activeCallWindow)[0];

        const target =
            this.pictureInPictureWindow.document.getElementById(
                "active_call_window",
            );

        if (!source || !target) {
            return;
        }

        target.className = source.className;

        target.innerHTML = source.innerHTML;

        this.bindPictureInPictureControls();
    };

    /*
     * ----------------------------------------
     * BIND PIP CONTROLS
     * ----------------------------------------
     */

    this.bindPictureInPictureControls = function () {
        if (
            !this.pictureInPictureWindow ||
            this.pictureInPictureWindow.closed
        ) {
            return;
        }

        const pipDocument = this.pictureInPictureWindow.document;

        const bind = function (id, handler) {
            const button = pipDocument.getElementById(id);

            if (button) {
                button.onclick = handler;
            }
        };

        bind("btn_mute_call", this.toggleMute.bind(this));

        bind("btn_speaker_call", this.toggleSpeaker.bind(this));

        bind("btn_end_call", this.endCall.bind(this));

        bind("btn_accept_incoming_call", this.acceptIncomingCall.bind(this));

        bind("btn_decline_incoming_call", this.declineIncomingCall.bind(this));

        bind("btn_minimize_call", this.minimizeCallWindow.bind(this));

        const popoutButton = pipDocument.getElementById("btn_popout_call");

        if (popoutButton) {
            popoutButton.style.display = "none";
        }

        const incomingPipButton = pipDocument.getElementById(
            "btn_open_incoming_pip",
        );

        if (incomingPipButton) {
            incomingPipButton.style.display = "none";
        }
    };

    /*
     * ----------------------------------------
     * CLOSE CALL WINDOW
     * ----------------------------------------
     */

    this.closeCallWindow = function () {
        this.endCall();
    };

    /*
     * ----------------------------------------
     * HANDLE BROWSER PAGE EXIT
     * ----------------------------------------
     */

    this.handlePageExit = function () {
        if (this.isPageExiting) {
            return;
        }

        this.isPageExiting = true;

        console.log("Browser page is closing or refreshing.");

        this.disconnectDoctorEvents();

        const doctorSession = this.getDoctorSession();

        /*
         * ----------------------------------------
         * STOP MICROPHONE
         * ----------------------------------------
         */

        if (this.microphoneStream) {
            this.microphoneStream.getTracks().forEach(function (track) {
                track.stop();
            });

            this.microphoneStream = null;
        }

        /*
         * ----------------------------------------
         * END BANDWIDTH VOICE CALL
         * ----------------------------------------
         */

        if (this.activePatient && doctorSession) {
            const payload = JSON.stringify({
                endpointId: doctorSession.endpointId,
            });

            const beaconSent = navigator.sendBeacon(
                "/api/calls/end",
                new Blob([payload], {
                    type: "application/json",
                }),
            );

            console.log("Bandwidth call end beacon sent:", beaconSent);
        }

        /*
         * ----------------------------------------
         * DELETE BRTC ENDPOINT
         * ----------------------------------------
         */

        if (doctorSession && doctorSession.endpointId) {
            const endpointPayload = JSON.stringify({
                endpointId: doctorSession.endpointId,
            });

            const endpointBeaconSent = navigator.sendBeacon(
                "/api/doctor/endpoint/cleanup",
                new Blob([endpointPayload], {
                    type: "application/json",
                }),
            );

            console.log(
                "BRTC endpoint cleanup beacon sent:",
                endpointBeaconSent,
            );

            localStorage.removeItem("doctorBrtcSession");
        }

        /*
         * ----------------------------------------
         * DISCONNECT BRTC
         * ----------------------------------------
         */

        if (window.bandwidthRtc) {
            try {
                window.bandwidthRtc.disconnect();

                console.log("BRTC disconnected during page exit.");
            } catch (error) {
                console.error("BRTC disconnect failed:", error);
            }
        }
    };

    /*
     * ----------------------------------------
     * LOGOUT DOCTOR
     * ----------------------------------------
     */

    this.logoutDoctor = async function () {
        console.log("Doctor logout started.");

        this.disconnectDoctorEvents();

        /*
         * ----------------------------------------
         * END ACTIVE CALL
         * ----------------------------------------
         */

        if (this.activePatient) {
            await this.endCall();
        }

        /*
         * ----------------------------------------
         * DECLINE PENDING INCOMING CALL
         * ----------------------------------------
         */

        if (this.incomingCallActive && !this.incomingCallAccepted) {
            await this.declineIncomingCall();
        }

        /*
         * ----------------------------------------
         * STOP MICROPHONE
         * ----------------------------------------
         */

        await this.stopMicrophone();

        /*
         * ----------------------------------------
         * DISCONNECT BRTC
         * ----------------------------------------
         */

        if (window.bandwidthRtc) {
            try {
                await window.bandwidthRtc.disconnect();

                console.log("BRTC disconnected.");
            } catch (error) {
                console.error("BRTC disconnect failed:", error);
            }
        }

        /*
         * ----------------------------------------
         * DELETE CURRENT ENDPOINT
         * ----------------------------------------
         */

        const doctorSession = this.getDoctorSession();

        if (doctorSession && doctorSession.endpointId) {
            await this.deleteDoctorEndpoint(doctorSession.endpointId);
        }

        /*
         * ----------------------------------------
         * CLEAR SESSION
         * ----------------------------------------
         */

        localStorage.removeItem("doctorBrtcSession");

        console.log("Doctor BRTC session removed.");

        /*
         * ----------------------------------------
         * RETURN TO LOGIN
         * ----------------------------------------
         */

        $(this.selectors.appScreen).hide();

        $(this.selectors.loginScreen).show();

        $(this.selectors.loginButton).prop("disabled", false).text("Login");

        $(this.selectors.loginError).addClass("d-none").text("");

        $(this.selectors.doctorStatus)
            .removeClass("text-bg-success text-bg-danger")
            .addClass("text-bg-warning")
            .text("Disconnected");

        this.isPageExiting = false;

        console.log("Doctor logout completed.");
    };

    /*
     * ----------------------------------------
     * HANDLE PATIENT BUTTON
     * ----------------------------------------
     */

    this.handleCallPatientClick = function (event) {
        const patientId = $(event.currentTarget).data("patient-id");

        const patient = this.getPatient(patientId);

        if (!patient) {
            return;
        }

        this.callPatient(patient);
    };

    /*
     * ----------------------------------------
     * BIND ALL REQUIRED EVENTS
     * ----------------------------------------
     */

    this.bindAllRequiredEvents = function () {
        /*
         * Login.
         */

        $(this.selectors.loginButton).on(
            "click",
            function () {
                this.loginDoctor();
            }.bind(this),
        );

        /*
         * Logout.
         */

        $(this.selectors.logoutButton).on(
            "click",
            function () {
                this.logoutDoctor();
            }.bind(this),
        );

        /*
         * Patient call buttons.
         */

        $(document).on(
            "click",
            ".btn-call-patient",
            function (event) {
                this.handleCallPatientClick(event);
            }.bind(this),
        );

        /*
         * ----------------------------------------
         * ACCEPT INCOMING CALL
         * ----------------------------------------
         */

        $(this.selectors.acceptIncomingCallButton).on(
            "click",
            function () {
                this.acceptIncomingCall();
            }.bind(this),
        );

        /*
         * ----------------------------------------
         * DECLINE INCOMING CALL
         * ----------------------------------------
         */

        $(this.selectors.declineIncomingCallButton).on(
            "click",
            function () {
                this.declineIncomingCall();
            }.bind(this),
        );

        /*
         * End call.
         */

        $(this.selectors.endCallButton).on(
            "click",
            function () {
                this.endCall();
            }.bind(this),
        );

        /*
         * Close call.
         */

        $(this.selectors.closeCallButton).on(
            "click",
            function () {
                this.closeCallWindow();
            }.bind(this),
        );

        /*
         * Minimize call.
         */

        $(this.selectors.minimizeCallButton).on(
            "click",
            function () {
                this.minimizeCallWindow();
            }.bind(this),
        );

        /*
         * Open incoming PiP.
         */

        $(this.selectors.openIncomingPipButton).on(
            "click",
            function () {
                this.openCallPictureInPicture();
            }.bind(this),
        );

        /*
         * Popout call.
         */

        $(this.selectors.popoutCallButton).on(
            "click",
            function () {
                this.openCallPictureInPicture();
            }.bind(this),
        );

        /*
         * Mute.
         */

        $(this.selectors.muteCallButton).on(
            "click",
            function () {
                this.toggleMute();
            }.bind(this),
        );

        /*
         * Speaker.
         */

        $(this.selectors.speakerCallButton).on(
            "click",
            function () {
                this.toggleSpeaker();
            }.bind(this),
        );

        /*
         * ----------------------------------------
         * DRAG FLOATING CALL WINDOW
         * ----------------------------------------
         */

        $(this.selectors.callWindowHeader).on(
            "mousedown",
            function (event) {
                if ($(event.target).closest("button").length) {
                    return;
                }

                this.isDragging = true;

                const windowOffset = $(
                    this.selectors.activeCallWindow,
                ).offset();

                this.dragOffsetX = event.pageX - windowOffset.left;

                this.dragOffsetY = event.pageY - windowOffset.top;

                $(document)
                    .on(
                        "mousemove.callWindow",
                        function (event) {
                            if (!this.isDragging) {
                                return;
                            }

                            $(this.selectors.activeCallWindow).css({
                                left: event.pageX - this.dragOffsetX,
                                top: event.pageY - this.dragOffsetY,
                                right: "auto",
                                bottom: "auto",
                            });
                        }.bind(this),
                    )
                    .on(
                        "mouseup.callWindow",
                        function () {
                            this.isDragging = false;

                            $(document).off(".callWindow");
                        }.bind(this),
                    );
            }.bind(this),
        );

        /*
         * ----------------------------------------
         * BROWSER TAB CLOSE / REFRESH
         * ----------------------------------------
         */

        $(window).on(
            "pagehide",
            function () {
                this.handlePageExit();
            }.bind(this),
        );

        $(window).on(
            "beforeunload",
            function () {
                this.handlePageExit();
            }.bind(this),
        );
    };

    /*
     * ----------------------------------------
     * INITIALIZE
     * ----------------------------------------
     */

    this.bindBrtcEvents();

    this.bindAllRequiredEvents();
};

/*
 * ----------------------------------------
 * CREATE INSTANCE
 * ----------------------------------------
 */

$(document).ready(function () {
    const bandwidthVoicePocInstance = new bandwidthVoicePoc();

    window.bandwidthVoicePoc = bandwidthVoicePocInstance;
});
