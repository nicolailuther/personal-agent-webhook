const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

// Version for tracking deploys
const VERSION = "3.3.0";
const DEPLOY_TIME = new Date().toISOString();

// Store recent events (in-memory, max 100)
const events = [];
const MAX_EVENTS = 100;

// Debug log for operation results
const debugLog = [];

// Call history storage (persists caller info for display in Cortex)
const callHistory = [];
const MAX_CALL_HISTORY = 200;

// Track calls pending conference setup (answered but not yet in conference)
const pendingCalls = new Map();

// Track active conferences for join handling
const activeConferences = new Map();

// Track AI legs by call_control_id (for matching call.answered events)
const pendingAILegs = new Map();

// Agent phone numbers and their ElevenLabs config
const AGENT_PHONE_NUMBERS = {
  "+18635008639": {
    agentName: "Executive Assistant",
  },
};

// Connection ID for outbound calls (Call Control Application)
const OUTBOUND_CONNECTION_ID = "2887328154249069899";

app.use(cors());
app.use(express.json());

// Helper to log debug info
function logDebug(operation, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    operation,
    ...data,
  };
  debugLog.unshift(entry);
  if (debugLog.length > 50) debugLog.pop();
  console.log(`[Debug] ${operation}:`, JSON.stringify(data));
}

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "personal-agent-webhook",
    version: VERSION,
    deploy_time: DEPLOY_TIME,
    events_stored: events.length,
    pending_calls: pendingCalls.size,
    active_conferences: activeConferences.size,
    pending_ai_legs: pendingAILegs.size,
    timestamp: new Date().toISOString(),
  });
});

// Debug endpoint
app.get("/debug", (req, res) => {
  res.json({
    version: VERSION,
    deploy_time: DEPLOY_TIME,
    config: {
      hasTelnyxKey: !!process.env.TELNYX_API_KEY,
    },
    pending_calls: Array.from(pendingCalls.entries()),
    active_conferences: Array.from(activeConferences.entries()),
    pending_ai_legs: Array.from(pendingAILegs.entries()),
    recent_operations: debugLog.slice(0, 20),
  });
});

/**
 * Answer a call via Telnyx API
 */
async function answerCall(callControlId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    console.error("[Telnyx] No API key configured");
    return { success: false, error: "No API key" };
  }

  try {
    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.errors?.[0]?.detail || `API error: ${response.status}`);
    }

    return { success: true };
  } catch (error) {
    console.error("[Telnyx] Error answering call:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Create a conference with an initial call
 */
async function createConference(name, callControlId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return { success: false, error: "No API key" };

  try {
    console.log(`[Telnyx] Creating conference ${name} with call ${callControlId}`);
    const response = await fetch(
      "https://api.telnyx.com/v2/conferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name,
          beep_enabled: "never",
          call_control_id: callControlId,
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      const errorMsg = errorData.errors?.[0]?.detail || `API error: ${response.status}`;
      console.error(`[Telnyx] Conference creation failed: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const data = await response.json();
    console.log(`[Telnyx] Conference created: ${data.data.id}`);
    return { success: true, conferenceId: data.data.id };
  } catch (error) {
    console.error("[Telnyx] Error creating conference:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Join a call to a conference
 */
async function joinConference(conferenceId, callControlId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return { success: false, error: "No API key" };

  try {
    const response = await fetch(
      `https://api.telnyx.com/v2/conferences/${conferenceId}/actions/join`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          call_control_id: callControlId,
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.errors?.[0]?.detail || `API error: ${response.status}`);
    }

    return { success: true };
  } catch (error) {
    console.error("[Telnyx] Error joining conference:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Dial ElevenLabs SIP endpoint directly via Telnyx
 * This connects to the AI agent associated with the phone number
 *
 * SIP format: sip:<phone-number>@sip.rtc.elevenlabs.io
 */
async function dialElevenLabsSIP(agentPhoneNumber, conferenceId, callerFrom) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return { success: false, error: "No API key" };

  // Build SIP URI - strip the + from phone number
  const phoneDigits = agentPhoneNumber.replace("+", "");
  const sipUri = `sip:${phoneDigits}@sip.rtc.elevenlabs.io`;

  try {
    console.log(`[Telnyx] Dialing ElevenLabs SIP: ${sipUri}`);

    // Create client_state to track this call
    const clientState = Buffer.from(JSON.stringify({
      type: "ai_leg",
      conferenceId: conferenceId,
      callerFrom: callerFrom,
    })).toString("base64");

    const response = await fetch(
      "https://api.telnyx.com/v2/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connection_id: OUTBOUND_CONNECTION_ID,
          to: sipUri,
          from: agentPhoneNumber,
          client_state: clientState,
          answering_machine_detection: "disabled",
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      const errorMsg = errorData.errors?.[0]?.detail || `API error: ${response.status}`;
      console.error(`[Telnyx] SIP dial failed: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const data = await response.json();
    console.log(`[Telnyx] SIP call initiated: ${data.data.call_control_id}`);

    return {
      success: true,
      callControlId: data.data.call_control_id,
      callLegId: data.data.call_leg_id,
    };
  } catch (error) {
    console.error("[Telnyx] Error dialing SIP:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Handle call.initiated
 * - For regular inbound calls: answer and mark pending for conference setup
 */
async function handleCallInitiated(payload) {
  const callControlId = payload?.call_control_id;
  const to = payload?.to;
  const from = payload?.from;
  const direction = payload?.direction;

  // Only handle inbound calls
  if (!callControlId || (direction !== "inbound" && direction !== "incoming")) {
    return;
  }

  // Check if this is a call to one of our agent numbers
  const agentConfig = AGENT_PHONE_NUMBERS[to];
  if (!agentConfig) {
    console.log(`[Webhook] Inbound call to ${to} - not an agent number, ignoring`);
    return;
  }

  console.log(`[Webhook] Inbound call from ${from} to ${agentConfig.agentName} (${to})`);
  logDebug("call_initiated", { callControlId, from, to, agent: agentConfig.agentName });

  // Store pending info - we'll set up the conference when we get call.answered
  pendingCalls.set(callControlId, {
    from,
    to,
    agentConfig,
    timestamp: Date.now(),
  });

  // Store in call history for Cortex display
  const historyEntry = {
    id: `call_${Date.now()}_${callControlId.slice(-8)}`,
    callerPhone: from,
    agentPhone: to,
    agentName: agentConfig.agentName,
    direction: "inbound",
    status: "initiated",
    startTime: new Date().toISOString(),
    callControlId,
    conferenceId: null,
    aiCallControlId: null,
    endTime: null,
    duration: null,
  };
  callHistory.unshift(historyEntry);
  if (callHistory.length > MAX_CALL_HISTORY) callHistory.pop();

  // Answer the call
  console.log(`[Webhook] Answering call...`);
  const answerResult = await answerCall(callControlId);
  logDebug("answer_call", { callControlId, success: answerResult.success, error: answerResult.error });

  if (!answerResult.success) {
    console.error(`[Webhook] Failed to answer: ${answerResult.error}`);
    pendingCalls.delete(callControlId);
    return;
  }

  console.log(`[Webhook] Call answered, waiting for call.answered event to set up conference`);
}

/**
 * Handle call.answered
 * - For inbound calls: set up conference and dial ElevenLabs SIP
 * - For AI SIP calls: join to conference
 */
async function handleCallAnswered(payload) {
  const callControlId = payload?.call_control_id;
  const clientStateB64 = payload?.client_state;

  // Check if this is an AI leg answering (has client_state)
  if (clientStateB64) {
    try {
      const clientState = JSON.parse(Buffer.from(clientStateB64, "base64").toString());

      if (clientState.type === "ai_leg") {
        console.log(`[Webhook] AI SIP call answered! Joining to conference ${clientState.conferenceId}`);
        logDebug("ai_leg_answered", { callControlId, conferenceId: clientState.conferenceId });

        const joinResult = await joinConference(clientState.conferenceId, callControlId);
        logDebug("join_ai_to_conference", {
          conferenceId: clientState.conferenceId,
          callControlId,
          success: joinResult.success,
          error: joinResult.error,
        });

        if (!joinResult.success) {
          console.error(`[Webhook] Failed to join AI to conference: ${joinResult.error}`);
          return;
        }

        // Update activeConferences with AI call info
        for (const [confId, confData] of activeConferences.entries()) {
          if (confData.conferenceId === clientState.conferenceId) {
            confData.aiCallControlId = callControlId;
            confData.aiConnected = true;
            console.log(`[Webhook] Call connected! Caller <-> AI`);
            logDebug("call_connected", {
              conferenceId: clientState.conferenceId,
              callerFrom: clientState.callerFrom,
            });
            // Update call history with AI connection
            const historyEntry = callHistory.find(h => h.conferenceId === clientState.conferenceId);
            if (historyEntry) {
              historyEntry.aiCallControlId = callControlId;
              historyEntry.status = "connected";
            }
            break;
          }
        }
        return;
      }

      // Handle user joining a conference (from Cortex "Join" button)
      if (clientState.type === "conference_join") {
        console.log(`[Webhook] User answered! Joining to conference ${clientState.conference_id}`);
        logDebug("user_join_answered", { callControlId, conferenceId: clientState.conference_id });

        const joinResult = await joinConference(clientState.conference_id, callControlId);
        logDebug("join_user_to_conference", {
          conferenceId: clientState.conference_id,
          callControlId,
          success: joinResult.success,
          error: joinResult.error,
        });

        if (!joinResult.success) {
          console.error(`[Webhook] Failed to join user to conference: ${joinResult.error}`);
          return;
        }

        console.log(`[Webhook] User successfully joined conference!`);

        // Notify Cortex that user has joined (so "Take Over" button appears)
        const cortexUrl = process.env.CORTEX_URL || "https://command-center-five.vercel.app";
        const originalCallId = clientState.original_call_id;
        if (originalCallId) {
          fetch(`${cortexUrl}/api/calls/user-joined`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              call_id: originalCallId,
              conference_id: clientState.conference_id,
              user_call_control_id: callControlId,
            }),
          }).then(res => {
            console.log(`[Webhook] Notified Cortex of user join: ${res.status}`);
          }).catch(err => {
            console.error(`[Webhook] Failed to notify Cortex: ${err.message}`);
          });
        }

        return;
      }
    } catch (e) {
      // Not valid JSON client_state, continue normal flow
    }
  }

  // Check if this is an inbound call pending conference setup
  const pendingInfo = pendingCalls.get(callControlId);
  logDebug("call_answered_check", {
    callControlId,
    hasPendingInfo: !!pendingInfo,
    pendingCallsSize: pendingCalls.size,
  });

  if (pendingInfo) {
    pendingCalls.delete(callControlId);
    console.log(`[Webhook] Inbound call now answered, setting up conference...`);

    // Create conference with caller
    const confName = `call_${Date.now()}`;
    const confResult = await createConference(confName, callControlId);
    logDebug("create_conference", {
      confName,
      callControlId,
      success: confResult.success,
      conferenceId: confResult.conferenceId,
      error: confResult.error,
    });

    if (!confResult.success) {
      console.error(`[Webhook] Failed to create conference: ${confResult.error}`);
      return;
    }

    console.log(`[Webhook] Conference created: ${confResult.conferenceId}`);

    // Store conference info
    activeConferences.set(callControlId, {
      conferenceId: confResult.conferenceId,
      agentName: pendingInfo.agentConfig.agentName,
      callerFrom: pendingInfo.from,
      callerCallControlId: callControlId,
      agentPhoneNumber: pendingInfo.to,
      aiCallControlId: null,
      aiConnected: false,
      createdAt: new Date().toISOString(),
    });

    // Update call history entry with conference info
    const historyEntry = callHistory.find(h => h.callControlId === callControlId);
    if (historyEntry) {
      historyEntry.status = "in_progress";
      historyEntry.conferenceId = confResult.conferenceId;
    }

    // Dial ElevenLabs SIP endpoint
    console.log(`[Webhook] Dialing ElevenLabs SIP for ${pendingInfo.agentConfig.agentName}...`);

    const sipResult = await dialElevenLabsSIP(
      pendingInfo.to,
      confResult.conferenceId,
      pendingInfo.from
    );

    logDebug("dial_elevenlabs_sip", {
      agentPhoneNumber: pendingInfo.to,
      conferenceId: confResult.conferenceId,
      success: sipResult.success,
      aiCallControlId: sipResult.callControlId,
      error: sipResult.error,
    });

    if (!sipResult.success) {
      console.error(`[Webhook] Failed to dial ElevenLabs SIP: ${sipResult.error}`);
      return;
    }

    console.log(`[Webhook] ElevenLabs SIP call initiated. Waiting for AI to answer...`);
    return;
  }
}

/**
 * Handle call.hangup - cleanup and notify Cortex
 */
async function handleCallHangup(payload) {
  const callControlId = payload?.call_control_id;
  const hangupCause = payload?.hangup_cause || "unknown";
  const endTime = new Date().toISOString();

  // Update call history entry
  const historyEntry = callHistory.find(h =>
    h.callControlId === callControlId || h.aiCallControlId === callControlId
  );
  if (historyEntry && !historyEntry.endTime) {
    historyEntry.endTime = endTime;
    historyEntry.status = "completed";
    // Calculate duration
    if (historyEntry.startTime) {
      historyEntry.duration = Math.round(
        (new Date(endTime).getTime() - new Date(historyEntry.startTime).getTime()) / 1000
      );
    }
  }

  if (pendingCalls.has(callControlId)) {
    console.log(`[Webhook] Pending call ended before setup`);
    pendingCalls.delete(callControlId);
  }

  if (activeConferences.has(callControlId)) {
    console.log(`[Webhook] Call ended, cleaning up conference tracking`);
    activeConferences.delete(callControlId);
  }

  // Also check if this was an AI leg
  for (const [confCallId, confData] of activeConferences.entries()) {
    if (confData.aiCallControlId === callControlId) {
      console.log(`[Webhook] AI leg hung up, cleaning up`);
      confData.aiCallControlId = null;
      confData.aiConnected = false;
    }
  }

  // Notify Cortex that the call has ended
  const cortexUrl = process.env.CORTEX_URL || "https://command-center-five.vercel.app";
  try {
    const response = await fetch(`${cortexUrl}/api/calls/call-ended`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call_control_id: callControlId,
        call_id: historyEntry?.callId,
        reason: hangupCause,
      }),
    });
    const result = await response.json();
    console.log(`[Webhook] Notified Cortex of call hangup: ${result.changes || 0} rows updated`);
  } catch (err) {
    console.error(`[Webhook] Failed to notify Cortex of hangup:`, err.message);
  }
}

// Receive Telnyx webhooks
app.post("/telnyx-webhook", async (req, res) => {
  const { data } = req.body;

  if (!data) {
    return res.status(400).json({ error: "No data" });
  }

  const event = {
    id: `evt_${Date.now()}`,
    received_at: new Date().toISOString(),
    event_type: data.event_type,
    payload: data.payload,
    raw: data,
  };

  console.log(`[Webhook] Received: ${data.event_type}`);

  // Add to events array (FIFO)
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events.pop();
  }

  // Handle different event types
  if (data.event_type === "call.initiated") {
    handleCallInitiated(data.payload).catch((err) => {
      console.error("[Webhook] Error handling inbound call:", err.message);
    });
  } else if (data.event_type === "call.answered") {
    handleCallAnswered(data.payload).catch((err) => {
      console.error("[Webhook] Error handling call answered:", err.message);
    });
  } else if (data.event_type === "call.hangup") {
    handleCallHangup(data.payload).catch((err) => {
      console.error("[Webhook] Error handling call hangup:", err.message);
    });
  }

  // Forward to command-center if URL is configured
  const forwardUrl = process.env.FORWARD_WEBHOOK_URL;
  if (forwardUrl) {
    fetch(forwardUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    }).catch((err) => console.error("[Forward] Error:", err.message));
  }

  res.json({ success: true, event_id: event.id });
});

// Get recent events (for polling)
app.get("/events", (req, res) => {
  const since = req.query.since;
  const eventType = req.query.type;

  let filtered = events;

  if (since) {
    filtered = filtered.filter((e) => new Date(e.received_at) > new Date(since));
  }

  if (eventType) {
    filtered = filtered.filter((e) => e.event_type === eventType);
  }

  res.json({
    success: true,
    count: filtered.length,
    events: filtered.slice(0, 50),
  });
});

// Get a specific event
app.get("/events/:id", (req, res) => {
  const event = events.find((e) => e.id === req.params.id);
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }
  res.json({ success: true, event });
});

// Get active conferences
app.get("/conferences", (req, res) => {
  const confs = Array.from(activeConferences.entries()).map(
    ([callControlId, info]) => ({
      callControlId,
      ...info,
    })
  );
  res.json({ success: true, conferences: confs });
});

// Get call history (for Cortex call list display)
app.get("/call-history", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    success: true,
    calls: callHistory.slice(0, limit),
    total: callHistory.length,
  });
});

// Clear events (for testing)
app.delete("/events", (req, res) => {
  events.length = 0;
  res.json({ success: true, message: "Events cleared" });
});

app.listen(PORT, () => {
  console.log(`Personal Agent Webhook server running on port ${PORT}`);
  console.log(`Version: ${VERSION}`);
  console.log(`Webhook endpoint: POST /telnyx-webhook`);
  console.log(`Events endpoint: GET /events`);
  console.log(`Conferences endpoint: GET /conferences`);
  if (process.env.TELNYX_API_KEY) {
    console.log(`Telnyx API key configured`);
  } else {
    console.log(`WARNING: No TELNYX_API_KEY`);
  }
});
