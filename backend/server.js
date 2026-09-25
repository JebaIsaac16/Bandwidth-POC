/*
 * ========================================
 * COMMON BACKEND (shared by inbound + outbound)
 * ========================================
 *
 * server.js           → config, OAuth, Bandwidth API helpers, shared state,
 *                        doctor login / BRTC endpoints, SSE, doctor busy state,
 *                        shared webhooks (endpoint events, disconnect)
 * outbound.server.js  → doctor calls patient
 * inbound.server.js   → patient calls doctor (assigned doctor + queue)
 * verification.server.js → shared caller verification (DOB + spoken name)
 *
 * Bandwidth dashboard (Voice application):
 *   Call Initiated URL : {NGROK_URL}/api/callbacks/voice/initiate
 *   Call Status URL    : {NGROK_URL}/api/callbacks/voice/disconnect
 */

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
 * TIMING
 * ---------------------------------------- */

const AFTER_CALL_DISPATCH_DELAY_MS = 2500; // let the browser finish cleanup first
const DISCONNECT_DISPATCH_DELAY_MS = 3000;
const SSE_HEARTBEAT_MS = 25000;

/* ----------------------------------------
 * SHARED STATE
 * ---------------------------------------- */

const brtcEndpointStatus = new Map(); // endpointId → { eligible, token, ... }
const doctorEndpointMap = new Map(); // doctorId → endpointId
const doctorEventClients = new Map(); // doctorId → Set(res)

/*
 * doctorId → { busyReason, activeCallId }
 *
 * busyReason: null | "outbound" | "inbound" | "browser"
 * activeCallId: connected inbound PSTN call id
 */

const doctorCallState = new Map();

/* ----------------------------------------
 * PATIENT DIRECTORY
 *
 * Used for:
 * - caller verification (DOB + first name + last name)
 * - patient → assigned doctor
 * - patient list in the browser (GET /api/patients, no DOB sent)
 *
 * EDIT these to your real test patients:
 *   dob          → "YYYY-MM-DD"
 *   phoneNumber  → E.164, must match the number the doctor dials
 *                  and the number the patient calls from
 * ---------------------------------------- */

const patients = [
    {
        id: "PT001",
        firstName: "Praveen",
        lastName: "Kumar",
        dob: "2004-01-01",
        phoneNumber:
            process.env.BANDWIDTH_PATIENT_1_PHONE || VOICE_PATIENT_NUMBER,
        doctorId: "D101",
    },
    {
        id: "PT002",
        firstName: "Bot",
        lastName: "Testing",
        dob: "1950-01-01",
        phoneNumber: process.env.BANDWIDTH_PATIENT_2_PHONE || "",
        doctorId: "D102",
    },
    {
        id: "PT003",
        firstName: "Patient",
        lastName: "Three",
        dob: "1948-12-25",
        phoneNumber: process.env.BANDWIDTH_PATIENT_3_PHONE || "",
        doctorId: "D101",
    },
];

const patientDoctorMap = new Map(
    patients.map(function (patient) {
        return [patient.id, patient.doctorId];
    }),
);

const patientPhoneMap = new Map(
    patients
        .filter(function (patient) {
            return patient.phoneNumber;
        })
        .map(function (patient) {
            return [patient.phoneNumber, patient.id];
        }),
);

function getPatientById(patientId) {
    return (
        patients.find(function (patient) {
            return patient.id === patientId;
        }) || null
    );
}

function findPatientByPhone(phoneNumber) {
    return getPatientById(patientPhoneMap.get(phoneNumber)) || null;
}

/* ----------------------------------------
 * SMALL HELPERS
 * ---------------------------------------- */

function safeJsonParse(value) {
    if (!value || typeof value !== "string") return null;

    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
}

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function sendBxml(res, verbs) {
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(
        '<?xml version="1.0" encoding="UTF-8"?><Response>' +
            verbs +
            "</Response>",
    );
}

function getPatientIdFromPhone(phoneNumber) {
    return patientPhoneMap.get(phoneNumber) || null;
}

/* ----------------------------------------
 * OAUTH ACCESS TOKEN
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
 * BRTC ENDPOINTS
 * ---------------------------------------- */

async function createDoctorEndpoint() {
    console.log("Creating new doctor BRTC endpoint");

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

    console.log("Endpoint response:", JSON.stringify(response.data, null, 2));

    return response.data.data;
}

function findDoctorByEndpoint(endpointId) {
    for (const [doctorId, mappedEndpointId] of doctorEndpointMap.entries()) {
        if (mappedEndpointId === endpointId) return doctorId;
    }

    return null;
}

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

async function deleteDoctorEndpoint(endpointId) {
    if (!endpointId) {
        throw new Error("endpointId is required");
    }

    const forget = function () {
        brtcEndpointStatus.delete(endpointId);
        removeDoctorEndpointMapping(endpointId);

        if (outboundModule) outboundModule.forgetEndpoint(endpointId);
    };

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

        forget();

        console.log("BRTC endpoint deleted:", endpointId);

        return { success: true, endpointId: endpointId, data: response.data };
    } catch (error) {
        if (error.response?.status === 404) {
            forget();

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
 * VOICE API HELPERS
 * ---------------------------------------- */

async function endVoiceCall(callId) {
    const accessToken = await getAccessToken();

    const response = await axios.post(
        `${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls/${callId}`,
        { state: "completed" },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        },
    );

    return response.data;
}

/*
 * Same as endVoiceCall, but a call that is already gone is not an error.
 */

async function endVoiceCallSafe(callId) {
    if (!callId || String(callId).startsWith("test-")) return false;

    try {
        await endVoiceCall(callId);

        console.log("Voice call ended:", callId);

        return true;
    } catch (error) {
        const status = error.response?.status;

        if (status && status < 500) {
            console.log(
                "Voice call already ended:",
                callId,
                "| status:",
                status,
            );
        } else {
            console.error(
                "Failed to end Voice call:",
                callId,
                error.response?.data || error.message,
            );
        }

        return false;
    }
}

async function redirectVoiceCall(callId, redirectUrl) {
    const accessToken = await getAccessToken();

    const response = await axios.post(
        `${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls/${callId}`,
        { redirectUrl: redirectUrl },
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
 * DOCTOR ONLINE / BUSY STATE
 * ---------------------------------------- */

function isDoctorOnline(doctorId) {
    const endpointId = doctorEndpointMap.get(doctorId);
    if (!endpointId) return false;

    const status = brtcEndpointStatus.get(endpointId);
    if (!status || status.eligible !== true) return false;

    const clients = doctorEventClients.get(doctorId);
    return Boolean(clients && clients.size);
}

function getDoctorCallState(doctorId) {
    if (!doctorCallState.has(doctorId)) {
        doctorCallState.set(doctorId, { busyReason: null, activeCallId: null });
    }

    return doctorCallState.get(doctorId);
}

function setDoctorBusy(doctorId, reason, callId) {
    const state = getDoctorCallState(doctorId);

    state.busyReason = reason;
    state.activeCallId = callId || null;

    console.log(
        "Doctor busy:",
        doctorId,
        "| reason:",
        reason,
        "| call:",
        callId || "-",
    );
}

/*
 * Doctor is free → after a short delay, ring the next queued patient.
 */

function markDoctorFree(doctorId, delayMs) {
    const state = getDoctorCallState(doctorId);

    state.busyReason = null;
    state.activeCallId = null;

    console.log("Doctor free:", doctorId);

    setTimeout(function () {
        if (inboundModule) inboundModule.dispatchNext(doctorId);
    }, delayMs || 0);
}

/* ----------------------------------------
 * SEND SSE EVENT TO DOCTOR
 * ---------------------------------------- */

function sendDoctorEvent(doctorId, event) {
    const clients = doctorEventClients.get(doctorId);

    if (!clients || !clients.size) {
        console.log("No SSE client connected for doctor:", doctorId);

        return false;
    }

    const message = `data: ${JSON.stringify(event)}\n\n`;

    console.log(`Doctor SSE → ${doctorId}:`, JSON.stringify(event));

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
 * LOAD OUTBOUND + INBOUND MODULES
 * ---------------------------------------- */

const ctx = {
    config: {
        NGROK_URL,
        ACCOUNT_ID,
        VOICE_API_URL,
        VOICE_APPLICATION_ID,
        VOICE_FACILITY_NUMBER,
        AFTER_CALL_DISPATCH_DELAY_MS,
        DISCONNECT_DISPATCH_DELAY_MS,
    },
    brtcEndpointStatus,
    doctorEndpointMap,
    doctorEventClients,
    patients,
    patientDoctorMap,
    getPatientById,
    findPatientByPhone,
    getAccessToken,
    endVoiceCall,
    endVoiceCallSafe,
    redirectVoiceCall,
    getPatientIdFromPhone,
    findDoctorByEndpoint,
    isDoctorOnline,
    getDoctorCallState,
    setDoctorBusy,
    markDoctorFree,
    sendDoctorEvent,
    safeJsonParse,
    xmlEscape,
    sendBxml,
};

// Shared caller verification (DOB + name), used by both directions.
const verificationModule = require("./verification.server")(app, ctx);
ctx.verification = verificationModule;

const outboundModule = require("./outbound.server")(app, ctx);
const inboundModule = require("./inbound.server")(app, ctx);

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
 * PATIENT LIST FOR THE BROWSER (no DOB)
 * ---------------------------------------- */

app.get("/api/patients", (req, res) => {
    res.json({
        success: true,
        patients: patients.map(function (patient) {
            return {
                id: patient.id,
                name: `${patient.firstName} ${patient.lastName}`,
                phoneNumber: patient.phoneNumber,
                doctorId: patient.doctorId,
            };
        }),
    });
});

/* ----------------------------------------
 * TEST BANDWIDTH AUTH
 * ---------------------------------------- */

app.get("/api/test-auth", async (req, res) => {
    try {
        await getAccessToken();

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

    console.log("Starting doctor session:", doctorId);

    try {
        const oldEndpointId = doctorEndpointMap.get(doctorId);

        if (oldEndpointId) {
            const oldStatus = brtcEndpointStatus.get(oldEndpointId);

            if (oldStatus?.eligible === true) {
                console.log(
                    "Doctor already has an active eligible endpoint:",
                    oldEndpointId,
                );

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

        brtcEndpointStatus.set(endpoint.endpointId, {
            eligible: false,
            deviceId: null,
            timestamp: Date.now(),
            token: endpoint.token,
            expirationTimestamp: endpoint.expirationTimestamp,
        });

        doctorEndpointMap.set(doctorId, endpoint.endpointId);

        // Fresh login → the doctor is not on any call.
        const state = getDoctorCallState(doctorId);
        state.busyReason = null;
        state.activeCallId = null;

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
 * ACTIVE DOCTORS (debugging)
 * ---------------------------------------- */

app.get("/api/doctors", (req, res) => {
    const doctors = Array.from(doctorEndpointMap.entries()).map(
        ([doctorId, endpointId]) => {
            const status = brtcEndpointStatus.get(endpointId);
            const callState = getDoctorCallState(doctorId);

            return {
                doctorId: doctorId,
                endpointId: endpointId,
                eligible: status?.eligible === true,
                online: isDoctorOnline(doctorId),
                busyReason: callState.busyReason,
                activeCallId: callState.activeCallId,
                deviceId: status?.deviceId || null,
                timestamp: status?.timestamp || null,
                expirationTimestamp: status?.expirationTimestamp || null,
            };
        },
    );

    res.json({ success: true, doctors: doctors });
});

/* ----------------------------------------
 * DELETE DOCTOR BRTC ENDPOINT
 * ---------------------------------------- */

app.delete("/api/doctor/endpoint/:endpointId", async (req, res) => {
    const endpointId = req.params.endpointId;

    console.log("Delete doctor BRTC endpoint:", endpointId);

    try {
        res.json(await deleteDoctorEndpoint(endpointId));
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
 * BRTC ENDPOINT CLEANUP (tab close beacon)
 * ---------------------------------------- */

app.post("/api/doctor/endpoint/cleanup", async (req, res) => {
    const endpointId = req.body?.endpointId;

    console.log("BRTC endpoint cleanup request:", endpointId);

    if (!endpointId) {
        return res.status(400).json({
            success: false,
            message: "endpointId is required",
        });
    }

    try {
        res.json(await deleteDoctorEndpoint(endpointId));
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
 * BRTC ENDPOINT STATUS
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
 * DOCTOR IDLE (browser finished any call)
 * ---------------------------------------- */

app.post("/api/doctor/idle", async (req, res) => {
    const doctorId = req.body?.doctorId;
    const pstnCallId = req.body?.pstnCallId || null;

    if (!doctorId) {
        return res.status(400).json({
            success: false,
            message: "doctorId is required",
        });
    }

    const state = getDoctorCallState(doctorId);

    /*
     * Server thinks the doctor is on a DIFFERENT inbound call
     * → this is a late message from an older call. Ignore it.
     */

    if (state.activeCallId && state.activeCallId !== pstnCallId) {
        console.log(
            "Stale idle ignored:",
            doctorId,
            "| active:",
            state.activeCallId,
        );

        return res.json({ success: true, ignored: true });
    }

    // Browser ended this call → make sure the phone leg is closed too.
    if (state.activeCallId) {
        await inboundModule.endActiveCall(state.activeCallId);
    }

    markDoctorFree(doctorId, AFTER_CALL_DISPATCH_DELAY_MS);

    res.json({ success: true });
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
 * BRTC CALLBACK (shared)
 *
 * endpointEligible / endpointIneligible → common
 * outboundConnectionRequest             → outbound.server.js
 * ---------------------------------------- */

app.post("/api/callbacks/bandwidth", async (req, res) => {
    console.log(
        "Bandwidth callback received:",
        JSON.stringify(req.body, null, 2),
    );

    const event = req.body || {};

    if (event.endpointId && event.event === "endpointEligible") {
        const existingStatus = brtcEndpointStatus.get(event.endpointId) || {};

        brtcEndpointStatus.set(event.endpointId, {
            ...existingStatus,
            eligible: true,
            deviceId: event.deviceId || null,
            timestamp: Date.now(),
        });

        console.log("BRTC endpoint is ELIGIBLE:", event.endpointId);

        // Patients may be waiting for this doctor.
        const doctorId = findDoctorByEndpoint(event.endpointId);

        if (doctorId) {
            setTimeout(function () {
                inboundModule.dispatchNext(doctorId);
            }, 1000);
        }

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

        /*
         * Mapping is kept on purpose: the endpoint can become
         * eligible again. It is removed when the endpoint is deleted.
         */

        console.log("BRTC endpoint is INELIGIBLE:", event.endpointId);
        console.log("Reason:", event.errorMessage || "Unknown");

        return res.sendStatus(200);
    }

    if (event.event === "outboundConnectionRequest") {
        return outboundModule.handleOutboundConnectionRequest(event, res);
    }

    res.sendStatus(200);
});

/* ----------------------------------------
 * BRTC CALLBACK FALLBACK
 * ---------------------------------------- */

app.post("/api/callbacks/bandwidth-fallback", (req, res) => {
    console.log(
        "Bandwidth FALLBACK callback received:",
        JSON.stringify(req.body, null, 2),
    );

    res.sendStatus(200);
});

/* ----------------------------------------
 * VOICE DISCONNECT (shared)
 *
 * Fires for BOTH inbound and outbound calls.
 * ---------------------------------------- */

app.post("/api/callbacks/voice/disconnect", (req, res) => {
    console.log(
        "Bandwidth Voice DISCONNECT:",
        JSON.stringify(req.body, null, 2),
    );

    const event = req.body || {};

    try {
        // Caller may hang up during verification (before inbound/outbound routing).
        const wasVerifying = verificationModule.handleDisconnect(event);

        const handled =
            inboundModule.handleDisconnect(event) ||
            outboundModule.handleDisconnect(event) ||
            wasVerifying;

        if (!handled) {
            console.log("Disconnect for untracked call:", event.callId);
        }
    } catch (error) {
        console.error("Disconnect handling error:", error.message);
    }

    res.sendStatus(200);
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
        `data: ${JSON.stringify({ type: "connected", doctorId: doctorId })}\n\n`,
    );

    // Show the current waiting list right away.
    inboundModule.broadcastQueue(doctorId);

    // Keep idle connections from being dropped.
    const heartbeat = setInterval(function () {
        try {
            res.write(": ping\n\n");
        } catch (error) {
            clearInterval(heartbeat);
        }
    }, SSE_HEARTBEAT_MS);

    req.on("close", () => {
        clearInterval(heartbeat);

        clients.delete(res);

        console.log("Doctor SSE disconnected:", doctorId);

        if (!clients.size) {
            doctorEventClients.delete(doctorId);
        }
    });
});

/* ----------------------------------------
 * START SERVER
 * ---------------------------------------- */

app.listen(PORT, () => {
    console.log("=================================");
    console.log("Bandwidth Voice POC backend started");
    console.log("Port:", PORT);
    console.log("=================================");
});
