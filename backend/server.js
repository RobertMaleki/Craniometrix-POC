const path = require("path");
const fs = require("fs");
const Fastify = require("fastify");
const fastifyFormBody = require("@fastify/formbody");
const fastifyWs = require("@fastify/websocket");
const fastifyStatic = require("@fastify/static");
const WebSocket = require("ws");
const twilio = require("twilio");
const dotenv = require("dotenv");
const { google } = require("googleapis");
dotenv.config();

// ---- Env ----
const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  PUBLIC_BASE_URL,
  PORT = 3000
} = process.env;

if (!OPENAI_API_KEY) console.warn("[env] OPENAI_API_KEY missing");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.warn("[env] Twilio creds missing");
if (!TWILIO_NUMBER) console.warn("[env] TWILIO_NUMBER missing");
if (!PUBLIC_BASE_URL) console.warn("[env] PUBLIC_BASE_URL missing");

// ---- Twilio client ----
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---- OpenAI Realtime config ----
const OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview-2025-06-03";
const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`;
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "OpenAI-Beta": "realtime=v1",
};

// ---- Agent system prompt ----
const VOICE = 'alloy';
function toFirstName(s) { return (s || "").trim().split(/\s+/)[0] || ""; }
function getSystemMessage(callerName) {
  const name = callerName;

  return `
    You are “Alice,” an empathetic outreach assistant with Craniometirx, calling on behalf of Dr. John Doe's office
    to inform families about Medicare’s GUIDE dementia care program and to offer a follow-up with a licensed care navigator.
    
    Goals:
      (1) get permission for a brief chat,
      (2) explain GUIDE in simple terms,
      (3) check for a dementia diagnosis (the person or their loved one),
      (4) if eligible and interested, collect best callback number + time window and confirm consent for a navigator to call,
      (5) if not interested/eligible, courteously close.
      
    Tone:
      - warm, respectful, plain language;
      - 1 or 2 sentences per turn; short phrases that allow barge-in; Keep utterances <~18 words and allow interruption; confirm understanding.
      - acknowledge emotions; never pressure.
    
    Safety:
      - no medical advice or financial guarantees;
      - route detailed questions to a care navigator;
      - collect only minimal scheduling details;
      - end immediately if asked.
      
    Language:
      - defaut language is English. If the caller speaks in another language, detect and continue in the caller's language
      - if unsure, ask preference.
    
    Opening:
      - This is Alice from Dr. John Doe's office in partnership with Craniometrix”;
      - Confirm the caller is available for a few minutes.
      - Only proceed if caller confirms they are available and this is a good time. Otherwise, offer to call back later and confirm day and time.
      - Ask for permission to share a brief overview.
        - If yes: explain GUIDE (care coordination, 24/7 support, respite for caregivers; Medicare-covered).
      - Ask if they or a loved one has a dementia/Alzheimer’s diagnosis.
      - If eligible + interested: arrange a navigator callback; collect number and time; confirm consent;
      - If info-first: offer to text a short overview.
      - If declines or not eligible: thank and close.
      `;
}



// List of Event Types to log to the console. See the OpenAI Realtime API Documentation.
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Google Functions
async function appendToSheet({
  sheetId,
  serviceEmail,
  privateKey,
  values, // array of arrays
}) {
  const jwt = new google.auth.JWT({
    email: serviceEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth: jwt });
  // Append to first sheet, next empty row
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "A1",
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

// ---- Call session store (per CallSid) ----
const SESSIONS = new Map();
function getOrCreateSession(callSid) {
  if (!SESSIONS.has(callSid)) {
    SESSIONS.set(callSid, {
      callSid,
      name: null,
      phone: null,
      userTranscript: [],
      agentTranscript: [],
      startedAt: new Date().toISOString(),
    });
  }
  return SESSIONS.get(callSid);
}

// =====================================================

// Initialize Fastify
const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Serve frontend
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
fastify.register(fastifyStatic, { root: FRONTEND_DIR, prefix: "/" });
fastify.get("/", async (_req, reply) => {
  const file = path.join(FRONTEND_DIR, "index.html");
  reply.type("text/html").send(fs.readFileSync(file, "utf8"));
});

fastify.all("/incoming-call", async (req, reply) => {
  const base = PUBLIC_BASE_URL || (`https://${req.headers.host}`);
  const callerName = (req.query && req.query.name) ? String(req.query.name) : "";
  const firstName = toFirstName(callerName);
  const wsUrl = base.replace(/^http/, "ws") + "/media-stream"+(firstName ? `?name=${encodeURIComponent(firstName)}` : "");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Say>Please wait while I connect you to a Crunch Fitness expert.</Say>
    <Connect>
      <Stream url="${wsUrl}">
        ${callerName ? `<Parameter name="name" value="${firstName}"/>` : ""}
      </Stream>
    </Connect>
  </Response>`;
  reply.type("text/xml").send(twiml);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    // Setup WebSocket server for handling media streams
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log("[media] Twilio connected:", req.headers["user-agent"] || "n/a");

       let callerName = (() => {
          try {
            const u = new URL(req.url, "http://localhost");
            return toFirstName(u.searchParams.get("name") || "");
          } catch { return ""; }
        })();


        function sendInitOnceOpen(payloads) {
          const sendAll = () => payloads.forEach(p => openaiWS.send(JSON.stringify(p)));
          if (openaiWS.readyState === WebSocket.OPEN) sendAll();
          else openaiWS.once('open', sendAll);
        }

        const openaiWS = new WebSocket(OPENAI_REALTIME_URL, { headers: OPENAI_HEADERS});

        let streamSid = null;
        let callSid = null;
        let closed = false;
        let userPartial = ""; // buffer for partial user utterance (per call)

        // ---- graceful, single-run cleanup + sheet append ----
        const flushAndEnd = async (reason) => {
            if (closed) return;
            closed = true;

            try {
            if (callSid) {
                const sess = SESSIONS.get(callSid);
                if (sess) {
                const row = [
                    new Date().toISOString(),
                    sess.callSid,
                    sess.name || "",
                    sess.phone || "",
                    sess.userTranscript.join(" ").trim(),
                    sess.agentTranscript.join("").trim()
                ];
                await appendToSheet({
                    sheetId: process.env.GOOGLE_SHEET_ID,
                    serviceEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
                    privateKey: process.env.GOOGLE_PRIVATE_KEY,
                    values: [row],
                });
                console.log("[sheet] appended row for", callSid);
                SESSIONS.delete(callSid);
                }
            } else {
                console.warn("[sheet] skip append: no callSid");
            }
            } catch (e) {
            console.error("[sheet] append error:", e?.message || e);
            } finally {
            try { if (openaiWS.readyState === WebSocket.OPEN) openaiWS.close(1000, "done"); } catch {}
            try { connection.close(1000, "done"); } catch {}
            console.log("[cleanup] closed. reason:", reason || "n/a");
            }
        };

        const sendInitialSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: getSystemMessage(callerName),
                    modalities: ["text", "audio"],
                    temperature: 0.8,

                    input_audio_transcription: {model: "gpt-4o-mini-transcribe"} // realtime-capable STT model
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openaiWS.send(JSON.stringify(sessionUpdate));
            
            // Make the AI speak first
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: "Begin the call with the step‑by‑step flow, starting with introducing yourself as Alice and confirming it's a good time to talk."
                        }
                    ]
                }
            };

            openaiWS.send(JSON.stringify(initialConversationItem));
            openaiWS.send(JSON.stringify({ type: 'response.create' }));
        };
        

        // Open event for OpenAI WebSocket
        openaiWS.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendInitialSessionUpdate, 100); // Ensure connection stability, send after .1 second
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openaiWS.on('message', (data) => {
            let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }

                // 1) Agent audio back to Twilio (so you hear the assistant)
                if (msg.type === 'response.audio.delta' && msg.audio && streamSid) {
                  connection.send(JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: msg.audio } // μ-law base64 passthrough
                  }));
                }

                // 2) USER transcript (incremental)
                if (msg.type === "conversation.item.input_audio_transcription.delta" && msg.delta) {
                  userPartial += msg.delta; // accumulate partial text
                }

                // 3) USER transcript (finalized)
                if (msg.type === "conversation.item.input_audio_transcription.completed") {
                  if (userPartial && callSid) {
                    const sess = getOrCreateSession(callSid);
                    sess.userTranscript.push(userPartial.trim());
                  }
                  userPartial = ""; // reset buffer
                }

                // 4) USER transcript (fallback path: sometimes emitted as a created user message)
                if (msg.type === "conversation.item.created" &&
                    msg.item?.role === "user" &&
                    !msg.item?.metadata?.bootstrap) {           // ignore our bootstrap
                  const texts = (msg.item.content || [])
                    .filter(p => p.type === "input_text" || p.type === "text")
                    .map(p => p.text)
                    .filter(Boolean);
                  if (texts.length && callSid) {
                    const sess = getOrCreateSession(callSid);
                    sess.userTranscript.push(texts.join(" ").trim());
                  }
                }

                // Transcribe agent
                if (msg.type === "response.audio_transcript.delta" && msg.delta) {
                    const sess = callSid ? getOrCreateSession(callSid) : null;
                    if (sess) sess.agentTranscript.push(msg.delta);
                }

            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        if (openaiWS.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };

                            openaiWS.send(JSON.stringify(audioAppend));
                        }
                        break;

                    case 'start':
                        streamSid = data.start.streamSid;
                        callSid = data.start?.callSid || callSid;   // Twilio includes CallSid here
                        console.log('Incoming stream has started', streamSid);

                          const startName = data.start?.customParameters?.name;
                          if (startName) callerName = toFirstName(startName);
                            if (startName) {
                              callerName = String(startName);
                              console.log('[twilio] custom name from Stream Parameter:', callerName);
                            } else {
                              console.log('[twilio] no custom name in start; using URL value:', callerName || '(none)');
                            }
                            console.log('Incoming stream has started', streamSid, 'callSid:', callSid);

                            // (Optional) If your initial session.update ran already on 'open' with a blank name,
                            // refresh the instructions now that we have the callerName:
                            try {
                              const refresh = {
                                type: 'session.update',
                                session: {
                                  instructions: getSystemMessage(callerName)
                                }
                              };
                              if (openaiWS.readyState === WebSocket.OPEN) {
                                openaiWS.send(JSON.stringify(refresh));
                              }
                            } catch (e) {
                              console.warn('[realtime] could not send name refresh:', e?.message || e);
                            }

                        break;

                    case "stop":
                        console.log("Incoming stream has stopped");
                        flushAndEnd("twilio stop");
                        break;

                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            flushAndEnd("twilio ws stop");
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openaiWS.on('close', () => {
            flushAndEnd("twilio stop");
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openaiWS.on('error', (error) => {
            flushAndEnd("twilio stop");
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Outbound call trigger (keeps your existing frontend flow)
fastify.post("/api/start-call", async (req, reply) => {
  try {
    const { name, phone } = req.body || {};
    if (!name || !phone) return reply.code(400).send({ error: "Missing name or phone" });
    const first = toFirstName(name);
    const twimlUrl = `${PUBLIC_BASE_URL}/incoming-call?name=${encodeURIComponent(first)}`;
    const call = await client.calls.create({
      to: phone,
      from: TWILIO_NUMBER,
      url: twimlUrl // Twilio fetches TwiML here -> Connect Stream to our WS
    });

    const sess = getOrCreateSession(call.sid);
    sess.name = name;
    sess.phone = phone;

    console.log("[start-call] created:", call.sid, "to:", phone);
    reply.send({ ok: true, sid: call.sid });
  } catch (err) {
    console.error("[start-call] error:", err?.message || err);
    reply.code(500).send({ error: err.message });
  }
});

// ---- Start server ----
fastify.listen({ port: Number(PORT), host: "0.0.0.0" })
  .then(() => console.log(`Fastify server → http://localhost:${PORT}`))
  .catch((e) => { console.error("Server failed:", e); process.exit(1); });