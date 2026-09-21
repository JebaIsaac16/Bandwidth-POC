const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const path = require("path");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "../public")));

const PORT = process.env.PORT || 3000;

const ACCOUNT_ID = process.env.BANDWIDTH_ACCOUNT_ID;
const CLIENT_ID = process.env.BANDWIDTH_CLIENT_ID;
const CLIENT_SECRET = process.env.BANDWIDTH_CLIENT_SECRET;

if (!ACCOUNT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing Bandwidth credentials in .env");
}

/* ----------------------------------------
 * BANDWIDTH API
 * ---------------------------------------- */

const BANDWIDTH_API_URL = "https://api.bandwidth.com";
const BRTC_ENDPOINT_API_URL = "https://api.bandwidth.com/v2";
const OAUTH_URL = `${BANDWIDTH_API_URL}/api/v1/oauth2/token`;

/* ----------------------------------------
 * NGROK CALLBACK URLS
 * ---------------------------------------- */

const NGROK_URL = process.env.NGROK_URL;

if (!NGROK_URL) {
    throw new Error("Missing NGROK_URL in .env");
}

const CALLBACK_URL = `${NGROK_URL}/api/callbacks/bandwidth`;
const FALLBACK_CALLBACK_URL = `${NGROK_URL}/api/callbacks/bandwidth-fallback`;

/* ----------------------------------------
 * BANDWIDTH VOICE API
 * ---------------------------------------- */

const VOICE_API_URL = "https://voice.bandwidth.com/api/v2";
const VOICE_APPLICATION_ID = process.env.BANDWIDTH_VOICE_APPLICATION_ID;
const VOICE_FACILITY_NUMBER = process.env.BANDWIDTH_VOICE_FACILITY_NUMBER;
const VOICE_PATIENT_NUMBER = process.env.BANDWIDTH_VOICE_PATIENT_NUMBER;

if (!VOICE_APPLICATION_ID || !VOICE_FACILITY_NUMBER || !VOICE_PATIENT_NUMBER) {
    throw new Error(
        "Missing Bandwidth Voice Application configuration in .env",
    );
}

/* ----------------------------------------
 * BRTC / VOICE STATE
 * ---------------------------------------- */

const pendingBrtcCallsByEndpoint = new Map();
const pendingBrtcCallsByCallId = new Map();
const brtcEndpointStatus = new Map();
const doctorEndpointMap = new Map();
const inboundBrtcCalls = new Map();
const incomingCallQueue = new Map();
const doctorEventClients = new Map();
const inboundCallSessions = new Map();
const inboundCallLegs = new Map();

const patientDoctorMap = new Map([
    ["PT001", ["D101"]],
    ["PT002", ["D101"]],
    ["PT003", ["D101"]],
]);

const patientPhoneMap = new Map([
    [VOICE_PATIENT_NUMBER, ["PT001", "PT002", "PT003"]],
]);

/* ----------------------------------------
 * GET BANDWIDTH OAUTH ACCESS TOKEN
 * ---------------------------------------- */

async function getAccessToken() {
    const response = await axios.post(
        OAUTH_URL,
        new URLSearchParams({ grant_type: "client_credentials" }),
        {
            auth: {
                username: CLIENT_ID,
                password: CLIENT_SECRET,
            },
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
        },
    );

    return response.data.access_token;
}

/* ----------------------------------------
 * CREATE DOCTOR BRTC ENDPOINT
 * ---------------------------------------- */

async function createDoctorEndpoint() {
    console.log("=================================");
    console.log("Creating new doctor BRTC endpoint");
    console.log("=================================");

    const accessToken = await getAccessToken();

    const response = await axios.post(
        `${BRTC_ENDPOINT_API_URL}/accounts/${ACCOUNT_ID}/endpoints`,
        {
            type: "WEBRTC",
            direction: "BIDIRECTIONAL",
            eventCallbackUrl: CALLBACK_URL,
            eventFallbackUrl: FALLBACK_CALLBACK_URL,
            tag: JSON.stringify({
                environment: "poc",
                role: "doctor",
            }),
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
        },
    );

    console.log("Doctor BRTC endpoint created");
    console.log("Endpoint response:", JSON.stringify(response.data, null, 2));

    return response.data.data;
}

/* ----------------------------------------
 * CREATE INBOUND BRTC CALL LEG
 *
 * OLD INBOUND FLOW
 *
 * NOT USED BY CURRENT DIRECT
 * PSTN -> <Connect><Endpoint> FLOW
 * ---------------------------------------- */

async function createInboundBrtcCall(
    endpointId,
    pstnCallId,
    doctorId,
    patientId,
) {
    const accessToken = await getAccessToken();

    const response = await axios.post(
        `${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls`,
        {
            from: VOICE_FACILITY_NUMBER,
            to: BRTC_LEG_TO_NUMBER,
            applicationId: VOICE_APPLICATION_ID,
            tag: JSON.stringify({
                type: "INBOUND_BRTC_LEG",
                pstnCallId: pstnCallId,
                endpointId: endpointId,
                doctorId: doctorId,
                patientId: patientId,
            }),
            answerUrl: `${NGROK_URL}/api/callbacks/voice/inbound-brtc-answer`,
            answerMethod: "POST",
            answerFallbackUrl: `${NGROK_URL}/api/callbacks/voice/answer-fallback`,
            disconnectUrl: `${NGROK_URL}/api/callbacks/voice/disconnect`,
            disconnectFallbackUrl: `${NGROK_URL}/api/callbacks/voice/disconnect-fallback`,
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        },
    );

    return response.data;
}

/* ----------------------------------------
 * REMOVE DOCTOR ENDPOINT MAPPING
 * ---------------------------------------- */

function removeDoctorEndpointMapping(endpointId) {
    for (const [doctorId, mappedEndpointId] of doctorEndpointMap.entries()) {
        if (mappedEndpointId === endpointId) {
            doctorEndpointMap.delete(doctorId);

            console.log(
                "Doctor endpoint mapping removed:",
                doctorId,
                "→",
                endpointId,
            );
        }
    }
}

/* ----------------------------------------
 * DELETE BRTC ENDPOINT
 * ---------------------------------------- */

async function deleteDoctorEndpoint(endpointId) {
    if (!endpointId) {
        throw new Error("endpointId is required");
    }

    const accessToken = await getAccessToken();

    try {
        const response = await axios.delete(
            `${BRTC_ENDPOINT_API_URL}/accounts/${ACCOUNT_ID}/endpoints/${endpointId}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/json",
                },
            },
        );

        brtcEndpointStatus.delete(endpointId);
        pendingBrtcCallsByEndpoint.delete(endpointId);
        removeDoctorEndpointMapping(endpointId);

        console.log("BRTC endpoint deleted:", endpointId);

        return {
            success: true,
            endpointId: endpointId,
            data: response.data,
        };
    } catch (error) {
        if (error.response?.status === 404) {
            brtcEndpointStatus.delete(endpointId);
            pendingBrtcCallsByEndpoint.delete(endpointId);
            removeDoctorEndpointMapping(endpointId);

            console.log("BRTC endpoint was already deleted:", endpointId);

            return {
                success: true,
                endpointId: endpointId,
                message: "Endpoint was already deleted.",
            };
        }

        throw error;
    }
}

/* ----------------------------------------
 * CREATE BANDWIDTH VOICE CALL
 *
 * OUTBOUND CODE — UNCHANGED
 * ---------------------------------------- */

async function createVoiceCall(endpointRequest) {
    const accessToken = await getAccessToken();

    const response = await axios.post(
        `${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls`,
        {
            from: VOICE_FACILITY_NUMBER,
            to: endpointRequest.to,
            applicationId: VOICE_APPLICATION_ID,
            tag: JSON.stringify({
                endpointId: endpointRequest.endpointId,
                deviceId: endpointRequest.deviceId,
            }),
            answerUrl: `${NGROK_URL}/api/callbacks/voice/answer`,
            answerFallbackUrl: `${NGROK_URL}/api/callbacks/voice/answer-fallback`,
            disconnectUrl: `${NGROK_URL}/api/callbacks/voice/disconnect`,
            disconnectFallbackUrl: `${NGROK_URL}/api/callbacks/voice/disconnect-fallback`,
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        },
    );

    return response.data;
}

/* ----------------------------------------
 * END BANDWIDTH VOICE CALL
 *
 * OUTBOUND CODE — UNCHANGED
 * ---------------------------------------- */

async function endVoiceCall(callId) {
    const accessToken = await getAccessToken();

    const response = await axios.post(
        `${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls/${callId}`,
        {
            state: "completed",
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        },
    );

    return response.data;
}

/* ----------------------------------------
 * REDIRECT ACTIVE CALL TO NEW BXML
 *
 * OUTBOUND / EXISTING CODE — UNCHANGED
 * ---------------------------------------- */

async function redirectVoiceCall(callId, redirectUrl) {
    const accessToken = await getAccessToken();

    const response = await axios.post(
        `${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls/${callId}`,
        {
            redirectUrl: redirectUrl,
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        },
    );

    return response.data;
}

/* ----------------------------------------
 * GET ELIGIBLE DOCTORS
 * ---------------------------------------- */

function getEligibleDoctors(doctorIds) {
    return doctorIds
        .map(function (doctorId) {
            const endpointId = doctorEndpointMap.get(doctorId);

            if (!endpointId) {
                return null;
            }

            const endpointStatus = brtcEndpointStatus.get(endpointId);

            if (!endpointStatus || endpointStatus.eligible !== true) {
                return null;
            }

            return {
                doctorId: doctorId,
                endpointId: endpointId,
            };
        })
        .filter(Boolean);
}

/* ----------------------------------------
 * GET PATIENT FROM PHONE
 * ---------------------------------------- */

function getPatientIdFromPhone(phoneNumber) {
    const patientIds = patientPhoneMap.get(phoneNumber);

    if (!patientIds || !patientIds.length) {
        return null;
    }

    return patientIds[0];
}

/* ----------------------------------------
 * FIND INBOUND LEG BY ENDPOINT
 * ---------------------------------------- */

function findInboundCallLegByEndpoint(endpointId) {
    for (const [pstnCallId, session] of inboundCallLegs.entries()) {
        const leg = session.legs.find(function (item) {
            return item.endpointId === endpointId;
        });

        if (leg) {
            return {
                pstnCallId: pstnCallId,
                session: session,
                leg: leg,
            };
        }
    }

    return null;
}

/* ----------------------------------------
 * FIND INBOUND LEG BY BRTC CALL ID
 * ---------------------------------------- */

function findInboundCallLegByBrtcCallId(brtcCallId) {
    for (const [pstnCallId, session] of inboundCallLegs.entries()) {
        const leg = session.legs.find(function (item) {
            return item.callId === brtcCallId;
        });

        if (leg) {
            return {
                pstnCallId: pstnCallId,
                session: session,
                leg: leg,
            };
        }
    }

    return null;
}

/* ----------------------------------------
 * HANG UP LOSING INBOUND LEGS
 *
 * OLD INBOUND FLOW
 * ---------------------------------------- */

async function hangupLosingInboundLegs(session, winningCallId) {
    for (const leg of session.legs) {
        if (!leg.callId || leg.callId === winningCallId) {
            continue;
        }

        try {
            console.log("Ending losing inbound BRTC leg:");
            console.log("Doctor:", leg.doctorId);
            console.log("Call ID:", leg.callId);

            await endVoiceCall(leg.callId);

            leg.status = "HUNG_UP";
        } catch (error) {
            console.error(
                "Failed to end losing inbound BRTC leg:",
                leg.callId,
                error.response?.data || error.message,
            );
        }
    }
}

/* ----------------------------------------
 * HEALTH CHECK
 * ---------------------------------------- */

app.get("/health", (req, res) => {
    res.json({
        success: true,
        message: "Bandwidth Voice POC backend is running",
    });
});

/* ----------------------------------------
 * TEST BANDWIDTH AUTH
 * ---------------------------------------- */

app.get("/api/test-auth", async (req, res) => {
    try {
        await getAccessToken();

        console.log("Bandwidth OAuth authentication successful");

        res.json({
            success: true,
            message: "Bandwidth OAuth authentication successful",
        });
    } catch (error) {
        console.error("OAuth error:", error.response?.data || error.message);

        res.status(500).json({
            success: false,
            message: "Bandwidth OAuth authentication failed",
            error: error.response?.data || error.message,
        });
    }
});

/* ----------------------------------------
 * CREATE DOCTOR SESSION
 * ---------------------------------------- */

app.post("/api/doctor/session", async (req, res) => {
    const doctorId = req.body?.doctorId;

    if (!doctorId) {
        return res.status(400).json({
            success: false,
            message: "doctorId is required",
        });
    }

    console.log("=================================");
    console.log("Starting doctor session");
    console.log("Assigned Doctor ID:", doctorId);
    console.log("=================================");

    try {
        const oldEndpointId = doctorEndpointMap.get(doctorId);

        if (oldEndpointId) {
            const oldStatus = brtcEndpointStatus.get(oldEndpointId);

            if (oldStatus?.eligible === true) {
                console.log("Doctor already has an active eligible endpoint");
                console.log("Doctor ID:", doctorId);
                console.log("Endpoint ID:", oldEndpointId);

                return res.json({
                    success: true,
                    doctorId: doctorId,
                    endpointId: oldEndpointId,
                    token: oldStatus.token || null,
                    expirationTimestamp: oldStatus.expirationTimestamp || null,
                    reused: true,
                });
            }

            doctorEndpointMap.delete(doctorId);
        }

        const endpoint = await createDoctorEndpoint();

        console.log("Doctor BRTC endpoint created");
        console.log("Endpoint ID:", endpoint.endpointId);
        console.log("Expiration:", endpoint.expirationTimestamp);

        brtcEndpointStatus.set(endpoint.endpointId, {
            eligible: false,
            deviceId: null,
            timestamp: Date.now(),
            token: endpoint.token,
            expirationTimestamp: endpoint.expirationTimestamp,
        });

        doctorEndpointMap.set(doctorId, endpoint.endpointId);

        console.log(
            "Doctor endpoint mapping:",
            doctorId,
            "→",
            endpoint.endpointId,
        );

        res.json({
            success: true,
            doctorId: doctorId,
            endpointId: endpoint.endpointId,
            token: endpoint.token,
            expirationTimestamp: endpoint.expirationTimestamp,
            reused: false,
        });
    } catch (error) {
        console.error(
            "BRTC endpoint creation error:",
            error.response?.data || error.message,
        );

        res.status(error.response?.status || 500).json({
            success: false,
            message: "Failed to create doctor BRTC session",
            error: error.response?.data || error.message,
        });
    }
});

/* ----------------------------------------
 * GET ACTIVE DOCTORS
 * ---------------------------------------- */

app.get("/api/doctors", (req, res) => {
    const doctors = Array.from(doctorEndpointMap.entries()).map(
        ([doctorId, endpointId]) => {
            const status = brtcEndpointStatus.get(endpointId);

            return {
                doctorId: doctorId,
                endpointId: endpointId,
                eligible: status?.eligible === true,
                deviceId: status?.deviceId || null,
                timestamp: status?.timestamp || null,
                expirationTimestamp: status?.expirationTimestamp || null,
            };
        },
    );

    res.json({
        success: true,
        doctors: doctors,
    });
});

/* ----------------------------------------
 * DELETE DOCTOR BRTC ENDPOINT
 * ---------------------------------------- */

app.delete("/api/doctor/endpoint/:endpointId", async (req, res) => {
    const endpointId = req.params.endpointId;

    console.log("=================================");
    console.log("Delete doctor BRTC endpoint");
    console.log("Endpoint ID:", endpointId);
    console.log("=================================");

    if (!endpointId) {
        return res.status(400).json({
            success: false,
            message: "endpointId is required",
        });
    }

    try {
        const result = await deleteDoctorEndpoint(endpointId);

        res.json(result);
    } catch (error) {
        console.error(
            "BRTC endpoint deletion error:",
            error.response?.data || error.message,
        );

        res.status(error.response?.status || 500).json({
            success: false,
            message: "Failed to delete BRTC endpoint",
            error: error.response?.data || error.message,
        });
    }
});

/* ----------------------------------------
 * BRTC ENDPOINT CLEANUP
 * ---------------------------------------- */

app.post("/api/doctor/endpoint/cleanup", async (req, res) => {
    const endpointId = req.body?.endpointId;

    console.log("=================================");
    console.log("BRTC endpoint cleanup request");
    console.log("Endpoint ID:", endpointId);
    console.log("=================================");

    if (!endpointId) {
        return res.status(400).json({
            success: false,
            message: "endpointId is required",
        });
    }

    try {
        const result = await deleteDoctorEndpoint(endpointId);

        res.json(result);
    } catch (error) {
        console.error(
            "BRTC endpoint cleanup error:",
            error.response?.data || error.message,
        );

        res.status(error.response?.status || 500).json({
            success: false,
            message: "Failed to cleanup BRTC endpoint",
            error: error.response?.data || error.message,
        });
    }
});

/* ----------------------------------------
 * GET BRTC ENDPOINT STATUS
 * ---------------------------------------- */

app.get("/api/doctor/endpoint-status", (req, res) => {
    const endpointId = req.query.endpointId;

    if (!endpointId) {
        return res.status(400).json({
            success: false,
            message: "endpointId is required",
        });
    }

    const status = brtcEndpointStatus.get(endpointId);

    res.json({
        success: true,
        endpointId: endpointId,
        eligible: status?.eligible === true,
        deviceId: status?.deviceId || null,
        timestamp: status?.timestamp || null,
        expirationTimestamp: status?.expirationTimestamp || null,
    });
});

/* ----------------------------------------
 * TEST CALLBACK
 * ---------------------------------------- */

app.get("/api/callbacks/test", (req, res) => {
    res.json({
        success: true,
        message: "Bandwidth callback endpoint is reachable",
    });
});

/* ----------------------------------------
 * BRTC CALLBACK
 * ---------------------------------------- */

app.post("/api/callbacks/bandwidth", async (req, res) => {
    console.log("=================================");
    console.log("Bandwidth callback received");
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    const event = req.body;

    if (event.endpointId && event.event === "endpointEligible") {
        const existingStatus = brtcEndpointStatus.get(event.endpointId) || {};

        brtcEndpointStatus.set(event.endpointId, {
            ...existingStatus,
            eligible: true,
            deviceId: event.deviceId || null,
            timestamp: Date.now(),
        });

        console.log("BRTC endpoint is ELIGIBLE:", event.endpointId);
        console.log("Device ID:", event.deviceId);

        return res.sendStatus(200);
    }

    if (event.endpointId && event.event === "endpointIneligible") {
        const existingStatus = brtcEndpointStatus.get(event.endpointId) || {};

        brtcEndpointStatus.set(event.endpointId, {
            ...existingStatus,
            eligible: false,
            deviceId: event.deviceId || null,
            timestamp: Date.now(),
            errorMessage: event.errorMessage || null,
            errorId: event.errorId || null,
        });

        removeDoctorEndpointMapping(event.endpointId);

        console.log("BRTC endpoint is INELIGIBLE:", event.endpointId);
        console.log("Reason:", event.errorMessage || "Unknown");

        return res.sendStatus(200);
    }

    /* ----------------------------------------
     * OLD INBOUND BRTC CALLBACK
     *
     * NOT USED BY CURRENT DIRECT
     * PSTN -> <Connect><Endpoint> FLOW
     * ---------------------------------------- */

    if (event.event === "incomingCall") {
        const endpointId = event.endpointId;

        if (!endpointId) {
            console.warn("Incoming BRTC call did not contain endpointId");
            return res.sendStatus(200);
        }

        const inboundLeg = findInboundCallLegByEndpoint(endpointId);

        if (!inboundLeg) {
            console.warn(
                "No inbound Voice leg found for endpoint:",
                endpointId,
            );

            return res.sendStatus(200);
        }

        const doctorId = inboundLeg.leg.doctorId;

        inboundLeg.leg.status = "RINGING";
        inboundLeg.leg.callId = event.callId || null;
        inboundLeg.leg.brtcEventCallId = event.callId || null;

        console.log("Incoming BRTC call for doctor:", doctorId);
        console.log("Endpoint:", endpointId);
        console.log("Patient PSTN call:", inboundLeg.pstnCallId);
        console.log("BRTC call:", event.callId || null);

        sendDoctorEvent(doctorId, {
            type: "incomingCall",
            pstnCallId: inboundLeg.pstnCallId,
            brtcCallId: event.callId || null,
            endpointId: endpointId,
            doctorId: doctorId,
            patientId: inboundLeg.session.patientId,
            from: inboundLeg.session.from,
        });

        return res.sendStatus(200);
    }

    if (event.event !== "outboundConnectionRequest") {
        return res.sendStatus(200);
    }

    if (event.toType !== "PHONE_NUMBER") {
        console.warn("Unsupported outbound destination type:", event.toType);

        return res.sendStatus(200);
    }

    const endpointStatus = brtcEndpointStatus.get(event.endpointId);

    if (!endpointStatus || endpointStatus.eligible !== true) {
        console.warn(
            "Outbound request received for endpoint that is not marked eligible:",
            event.endpointId,
        );

        return res.sendStatus(200);
    }

    /* ----------------------------------------
     * OUTBOUND CODE — UNCHANGED
     * ---------------------------------------- */

    const pendingCall = {
        endpointId: event.endpointId,
        deviceId: event.deviceId,
        from: event.from,
        to: event.to,
        toType: event.toType,
        fromType: event.fromType,
        timestamp: event.timestamp,
    };

    pendingBrtcCallsByEndpoint.set(event.endpointId, pendingCall);

    console.log("Pending BRTC call stored:");
    console.log(JSON.stringify(pendingCall, null, 2));

    res.sendStatus(200);

    try {
        const voiceCall = await createVoiceCall(event);

        console.log("Bandwidth Voice call created:");
        console.log(JSON.stringify(voiceCall, null, 2));

        const callId = voiceCall.callId || voiceCall.id;

        if (!callId) {
            throw new Error("Voice API response did not contain callId.");
        }

        pendingCall.callId = callId;

        pendingBrtcCallsByEndpoint.set(event.endpointId, pendingCall);
        pendingBrtcCallsByCallId.set(callId, pendingCall);

        console.log("BRTC Endpoint ID:", event.endpointId);
        console.log("Voice Call ID:", callId);
    } catch (error) {
        console.error(
            "Failed to create Bandwidth Voice call:",
            error.response?.data || error.message,
        );

        pendingBrtcCallsByEndpoint.delete(event.endpointId);
    }
});

/* ----------------------------------------
 * BRTC CALLBACK FALLBACK
 * ---------------------------------------- */

app.post("/api/callbacks/bandwidth-fallback", (req, res) => {
    console.log("=================================");
    console.log("Bandwidth FALLBACK callback received");
    console.log("Headers:");
    console.log(req.headers);
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    res.sendStatus(200);
});

/* ----------------------------------------
 * VOICE ANSWER CALLBACK
 *
 * OUTBOUND CODE — UNCHANGED
 * ---------------------------------------- */

app.post("/api/callbacks/voice/answer", (req, res) => {
    console.log("=================================");
    console.log("Bandwidth Voice ANSWER callback");
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    const event = req.body;
    const callId = event.callId;

    const pendingCall = pendingBrtcCallsByCallId.get(callId);

    if (!pendingCall) {
        console.error("No BRTC call found for Voice call:", callId);

        res.set("Content-Type", "application/xml; charset=utf-8");
        res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

        return;
    }

    const endpointId = pendingCall.endpointId;

    console.log("Connecting Voice call to BRTC endpoint:");
    console.log("Call ID:", callId);
    console.log("Endpoint ID:", endpointId);

    const bxml =
        '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Endpoint>' +
        endpointId +
        "</Endpoint></Connect></Response>";

    console.log("Sending BXML:");
    console.log(bxml);

    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(bxml);
});

/* ----------------------------------------
 * INBOUND BRTC LEG ANSWER CALLBACK
 *
 * OLD INBOUND FLOW
 * ---------------------------------------- */

app.post("/api/callbacks/voice/inbound-brtc-answer", (req, res) => {
    console.log("=================================");
    console.log("Inbound BRTC LEG ANSWER callback");
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    const event = req.body;
    const brtcCallId = event.callId;
    const tagValue = event.tag;

    let tag = null;

    try {
        tag = tagValue ? JSON.parse(tagValue) : null;
    } catch (error) {
        console.warn("Unable to parse inbound BRTC leg tag:", tagValue);
    }

    if (!tag || tag.type !== "INBOUND_BRTC_LEG") {
        console.error("Invalid inbound BRTC leg tag:", tagValue);

        res.set("Content-Type", "application/xml; charset=utf-8");
        res.send(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
        );

        return;
    }

    const endpointId = tag.endpointId;
    const pstnCallId = tag.pstnCallId;

    const session = inboundCallLegs.get(pstnCallId);

    if (!session) {
        console.error("Inbound session not found:", pstnCallId);

        res.set("Content-Type", "application/xml; charset=utf-8");
        res.send(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
        );

        return;
    }

    const leg = session.legs.find(function (item) {
        return item.endpointId === endpointId;
    });

    if (!leg) {
        console.error("Inbound BRTC leg not found:", endpointId);

        res.set("Content-Type", "application/xml; charset=utf-8");
        res.send(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
        );

        return;
    }

    leg.callId = brtcCallId;
    leg.status = "CONNECTED";

    console.log("Inbound BRTC leg connected");
    console.log("PSTN Call ID:", pstnCallId);
    console.log("BRTC Call ID:", brtcCallId);
    console.log("Doctor:", leg.doctorId);
    console.log("Endpoint:", endpointId);

    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Endpoint>' +
            endpointId +
            "</Endpoint></Connect></Response>",
    );
});

/* ----------------------------------------
 * VOICE ANSWER FALLBACK
 * ---------------------------------------- */

app.post("/api/callbacks/voice/answer-fallback", (req, res) => {
    console.log("=================================");
    console.log("Bandwidth Voice ANSWER FALLBACK");
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
    );
});

/* ----------------------------------------
 * VOICE DISCONNECT CALLBACK
 * ---------------------------------------- */

app.post("/api/callbacks/voice/disconnect", async (req, res) => {
    console.log("=================================");
    console.log("Bandwidth Voice DISCONNECT callback");
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    const event = req.body;
    const callId = event.callId;

    const pendingCall = pendingBrtcCallsByCallId.get(callId);

    if (pendingCall) {
        pendingBrtcCallsByCallId.delete(callId);
        pendingBrtcCallsByEndpoint.delete(pendingCall.endpointId);

        console.log("Outbound BRTC call cleaned up:", callId);
    }

    const inboundSession = inboundCallSessions.get(callId);

    if (inboundSession) {
        inboundCallSessions.delete(callId);
        inboundCallLegs.delete(callId);
        inboundBrtcCalls.delete(callId);

        console.log("Inbound call session cleaned up:", callId);
    }

    res.sendStatus(200);
});

/* ----------------------------------------
 * VOICE DISCONNECT FALLBACK
 * ---------------------------------------- */

app.post("/api/callbacks/voice/disconnect-fallback", (req, res) => {
    console.log("=================================");
    console.log("Bandwidth Voice DISCONNECT FALLBACK");
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    res.sendStatus(200);
});

/* ----------------------------------------
 * END OUTBOUND CALL
 *
 * OUTBOUND CODE — UNCHANGED
 * ---------------------------------------- */

app.post("/api/calls/end", async (req, res) => {
    console.log("=================================");
    console.log("End call request received");
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    const callId = req.body?.callId;
    const endpointId = req.body?.endpointId;

    if (!callId && !endpointId) {
        return res.status(400).json({
            success: false,
            message: "callId or endpointId is required",
        });
    }

    try {
        if (callId) {
            console.log("Ending Bandwidth Voice call:", callId);
            await endVoiceCall(callId);

            pendingBrtcCallsByCallId.delete(callId);
        }

        if (endpointId) {
            console.log("Endpoint ID:", endpointId);
            pendingBrtcCallsByEndpoint.delete(endpointId);
        }

        res.json({
            success: true,
            message: "Call ended successfully",
        });
    } catch (error) {
        console.error("End call error:", error.response?.data || error.message);

        res.status(error.response?.status || 500).json({
            success: false,
            message: "Failed to end call",
            error: error.response?.data || error.message,
        });
    }
});

/* ----------------------------------------
 * INBOUND VOICE INITIATE
 *
 * CURRENT INBOUND FLOW
 *
 * PSTN
 *   ↓
 * Bandwidth Voice
 *   ↓
 * This webhook
 *   ↓
 * Identify patient if possible
 *   ↓
 * Unknown caller is still allowed
 *   ↓
 * Find doctor
 *   ↓
 * Check BRTC endpoint eligibility
 *   ↓
 * Notify doctor browser through SSE
 *   ↓
 * <Connect><Endpoint>
 * ---------------------------------------- */

app.post("/api/callbacks/voice/initiate", async (req, res) => {
    try {
        console.log("=================================");
        console.log("Inbound Voice call received");
        console.log("Body:");
        console.log(JSON.stringify(req.body, null, 2));
        console.log("=================================");

        const callId = req.body.callId;
        const from = req.body.from;
        const to = req.body.to;

        const patientId = getPatientIdFromPhone(from);

        /* ----------------------------------------
         * PATIENT IDENTIFICATION
         * ---------------------------------------- */

        if (patientId) {
            console.log("Caller identified as PATIENT:", patientId);
            console.log("Patient phone number:", from);
        } else {
            console.log("Caller is NOT a registered patient.");
            console.log("Caller phone number:", from);
        }

        console.log("Patient identification result:", patientId || "UNKNOWN");

        /* ----------------------------------------
         * FIND DOCTOR
         *
         * REGISTERED PATIENT
         * → use assigned doctor
         *
         * UNKNOWN CALLER
         * → use D101 for this POC
         * ---------------------------------------- */

        const doctorIds = patientId
            ? patientDoctorMap.get(patientId) || []
            : ["D101"];

        if (!doctorIds.length) {
            console.log(
                "No doctors assigned to patient:",
                patientId || "UNKNOWN",
            );

            console.log("Inbound call cannot be routed to a doctor.");

            res.set("Content-Type", "application/xml; charset=utf-8");
            res.send(
                '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
            );

            return;
        }

        const eligibleDoctors = getEligibleDoctors(doctorIds);

        console.log("Eligible doctors:", eligibleDoctors);

        if (!eligibleDoctors.length) {
            console.log("No assigned doctor is currently available.");

            res.set("Content-Type", "application/xml; charset=utf-8");
            res.send(
                '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
            );

            return;
        }

        const doctor = eligibleDoctors[0];

        /* ----------------------------------------
         * CREATE INBOUND APPLICATION SESSION
         * ---------------------------------------- */

        const session = {
            pstnCallId: callId,
            patientId: patientId,
            from: from,
            to: to,
            status: "RINGING",
            doctorIds: [doctor.doctorId],
            legs: [
                {
                    doctorId: doctor.doctorId,
                    endpointId: doctor.endpointId,
                    callId: null,
                    brtcEventCallId: null,
                    status: "RINGING",
                    answered: false,
                },
            ],
            winningDoctorId: null,
            winningEndpointId: null,
            winningCallId: null,
            createdAt: Date.now(),
        };

        inboundCallLegs.set(callId, session);
        inboundCallSessions.set(callId, session);
        inboundBrtcCalls.set(callId, session);

        /* ----------------------------------------
         * NOTIFY DOCTOR BROWSER
         * ---------------------------------------- */

        const doctorBrowserNotified = sendDoctorEvent(doctor.doctorId, {
            type: "incomingPstnCall",
            pstnCallId: callId,
            endpointId: doctor.endpointId,
            doctorId: doctor.doctorId,
            patientId: patientId,
            from: from,
            to: to,
        });

        console.log(
            "Doctor browser notification:",
            doctorBrowserNotified ? "SENT" : "NOT CONNECTED",
        );

        console.log("=================================");
        console.log("Connecting inbound PSTN call directly to BRTC");
        console.log("Patient:", patientId || "UNKNOWN");
        console.log("Doctor:", doctor.doctorId);
        console.log("Endpoint:", doctor.endpointId);
        console.log("PSTN Call:", callId);
        console.log("=================================");

        /* ----------------------------------------
         * DIRECT PSTN -> BRTC ENDPOINT
         * ---------------------------------------- */

        const bxml =
            '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Endpoint>' +
            doctor.endpointId +
            "</Endpoint></Connect></Response>";

        console.log("Sending BXML:");
        console.log(bxml);

        res.set("Content-Type", "application/xml; charset=utf-8");
        res.send(bxml);
    } catch (error) {
        console.error(
            "Inbound Voice webhook failed:",
            error.response?.data || error.message,
        );

        res.status(error.response?.status || 500)
            .type("application/xml")
            .send(
                '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
            );
    }
});

/* ----------------------------------------
 * DOCTOR ACCEPT INBOUND PSTN CALL
 *
 * CURRENT INBOUND FLOW
 *
 * Browser Accept
 *   ↓
 * This endpoint updates application state
 *   ↓
 * Browser BRTC SDK accepts incoming stream
 * ---------------------------------------- */

app.post("/api/calls/inbound/accept", async (req, res) => {
    console.log("=================================");
    console.log("Doctor accepted inbound PSTN call");
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    const pstnCallId = req.body?.pstnCallId;
    const doctorId = req.body?.doctorId;
    const endpointId = req.body?.endpointId;

    if (!pstnCallId || !doctorId || !endpointId) {
        return res.status(400).json({
            success: false,
            message: "pstnCallId, doctorId and endpointId are required",
        });
    }

    const session = inboundCallLegs.get(pstnCallId);

    if (!session) {
        return res.status(404).json({
            success: false,
            message: "Inbound call session not found",
        });
    }

    const leg = session.legs.find(function (item) {
        return item.doctorId === doctorId && item.endpointId === endpointId;
    });

    if (!leg) {
        return res.status(404).json({
            success: false,
            message: "Inbound doctor leg not found",
        });
    }

    leg.status = "ANSWERED";
    leg.answered = true;

    session.status = "CONNECTED";
    session.winningDoctorId = doctorId;
    session.winningEndpointId = endpointId;
    session.winningCallId = leg.callId || null;

    console.log("Inbound call accepted");
    console.log("PSTN Call ID:", pstnCallId);
    console.log("Doctor:", doctorId);
    console.log("Endpoint:", endpointId);

    await hangupLosingInboundLegs(session, session.winningCallId);

    res.json({
        success: true,
        pstnCallId: pstnCallId,
        doctorId: doctorId,
        endpointId: endpointId,
        patientId: session.patientId,
        from: session.from,
    });
});

/* ----------------------------------------
 * DOCTOR DECLINE INBOUND PSTN CALL
 * ---------------------------------------- */

app.post("/api/calls/inbound/decline", async (req, res) => {
    console.log("=================================");
    console.log("Doctor declined inbound PSTN call");
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    const pstnCallId = req.body?.pstnCallId;
    const doctorId = req.body?.doctorId;

    if (!pstnCallId || !doctorId) {
        return res.status(400).json({
            success: false,
            message: "pstnCallId and doctorId are required",
        });
    }

    const session = inboundCallLegs.get(pstnCallId);

    if (!session) {
        return res.status(404).json({
            success: false,
            message: "Inbound call session not found",
        });
    }

    const leg = session.legs.find(function (item) {
        return item.doctorId === doctorId;
    });

    if (leg) {
        leg.status = "DECLINED";
        leg.answered = false;
    }

    console.log("Inbound call declined by doctor:", doctorId);

    res.json({
        success: true,
        pstnCallId: pstnCallId,
        doctorId: doctorId,
    });
});

/* ----------------------------------------
 * TEST INCOMING CALL
 * ---------------------------------------- */

app.post("/api/test/incoming-call", (req, res) => {
    console.log("=================================");
    console.log("TEST INCOMING CALL");
    console.log("Body:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    const from = req.body?.from || VOICE_PATIENT_NUMBER;

    const patientId = getPatientIdFromPhone(from);

    const doctorIds = patientId
        ? patientDoctorMap.get(patientId) || []
        : ["D101"];

    const eligibleDoctors = getEligibleDoctors(doctorIds);

    if (!eligibleDoctors.length) {
        console.log("No eligible doctor available for test incoming call");

        return res.status(409).json({
            success: false,
            message: "No eligible doctor available",
        });
    }

    const doctor = eligibleDoctors[0];

    const testCallId = `test-${Date.now()}`;

    const session = {
        pstnCallId: testCallId,
        patientId: patientId,
        from: from,
        to: VOICE_FACILITY_NUMBER,
        status: "RINGING",
        doctorIds: [doctor.doctorId],
        legs: [
            {
                doctorId: doctor.doctorId,
                endpointId: doctor.endpointId,
                callId: null,
                brtcEventCallId: null,
                status: "RINGING",
                answered: false,
            },
        ],
        winningDoctorId: null,
        winningEndpointId: null,
        winningCallId: null,
        createdAt: Date.now(),
    };

    inboundCallLegs.set(testCallId, session);

    inboundCallSessions.set(testCallId, session);

    inboundBrtcCalls.set(testCallId, session);

    console.log("Test incoming call created:", testCallId);

    console.log("Patient:", patientId || "UNKNOWN");

    console.log("Doctor:", doctor.doctorId);

    sendDoctorEvent(doctor.doctorId, {
        type: "incomingPstnCall",
        pstnCallId: testCallId,
        endpointId: doctor.endpointId,
        doctorId: doctor.doctorId,
        patientId: patientId,
        from: from,
        to: VOICE_FACILITY_NUMBER,
    });

    res.json({
        success: true,
        pstnCallId: testCallId,
        patientId: patientId,
        doctorId: doctor.doctorId,
        endpointId: doctor.endpointId,
        from: from,
    });
});

/* ----------------------------------------
 * DOCTOR SSE
 * ---------------------------------------- */

app.get("/api/doctor/events", (req, res) => {
    const doctorId = req.query.doctorId;

    if (!doctorId) {
        return res.status(400).json({
            success: false,
            message: "doctorId is required",
        });
    }

    console.log("Doctor SSE connected:", doctorId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    if (res.flushHeaders) {
        res.flushHeaders();
    }

    if (!doctorEventClients.has(doctorId)) {
        doctorEventClients.set(doctorId, new Set());
    }

    const clients = doctorEventClients.get(doctorId);

    clients.add(res);

    res.write(
        `data: ${JSON.stringify({
            type: "connected",
            doctorId: doctorId,
        })}\n\n`,
    );

    req.on("close", () => {
        clients.delete(res);

        console.log("Doctor SSE disconnected:", doctorId);

        if (!clients.size) {
            doctorEventClients.delete(doctorId);
        }
    });
});

/* ----------------------------------------
 * SEND DOCTOR EVENT
 * ---------------------------------------- */

function sendDoctorEvent(doctorId, event) {
    const clients = doctorEventClients.get(doctorId);

    if (!clients || !clients.size) {
        console.log("No SSE client connected for doctor:", doctorId);

        return false;
    }

    const message = `data: ${JSON.stringify(event)}\n\n`;

    for (const client of clients) {
        try {
            client.write(message);
        } catch (error) {
            console.error("Failed to send doctor SSE event:", error.message);

            clients.delete(client);
        }
    }

    return true;
}

/* ----------------------------------------
 * START SERVER
 * ---------------------------------------- */

app.listen(PORT, () => {
    console.log("=================================");
    console.log("Bandwidth Voice POC backend started");
    console.log("Port:", PORT);
    console.log("=================================");
});
