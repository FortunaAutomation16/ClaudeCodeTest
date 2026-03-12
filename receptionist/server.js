require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ─── Startup checks ────────────────────────────────────────────────────────

const required = ['ANTHROPIC_API_KEY', 'TWILIO_AUTH_TOKEN', 'ELEVENLABS_API_KEY', 'BASE_URL', 'BUSINESS_NAME', 'BUSINESS_PHONE'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('\n❌ Missing required environment variables:', missing.join(', '));
  console.error('   Fill them in receptionist/.env then restart.\n');
  process.exit(1);
}

const {
  ANTHROPIC_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL',
  BUSINESS_NAME,
  BUSINESS_PHONE,
  BASE_URL,
  ZAPIER_WEBHOOK_URL,
  PORT = 3000,
} = process.env;

// ─── Setup ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const audioDir = path.join(__dirname, 'audio');
fs.mkdirSync(audioDir, { recursive: true });
app.use('/audio', express.static(audioDir));

// In-memory conversation store keyed by Twilio CallSid
const conversations = {};

// ─── System prompt ─────────────────────────────────────────────────────────

function buildSystemPrompt(businessName) {
  return `You are the receptionist for ${businessName}, a trade services business (electrician/plumber/etc.).

RULES:
- Keep every response under 35 words — this is a phone call
- Be calm, professional, and direct — no exclamations, no drama, no filler words
- Ask only ONE question at a time — never stack questions
- Never say you are an AI. If asked directly, say "I'm the receptionist for ${businessName}"

YOUR TASK:
For job requests, collect these one at a time:
  1. Description of the problem
  2. Their address or location
  3. Their name and a callback number

For general questions (hours, pricing, service area): answer briefly and helpfully.

SIGNALS — append exactly one of these to your response when appropriate:
- When you have all 3 pieces of booking info:
  [BOOKING: name="X" phone="X" issue="X" location="X"]
- When the call should end naturally (after closing):
  [END]

When you have all the booking info, close with: "We'll send you a text summary of this call, and someone will follow up with you as soon as possible. Thanks for calling, take care!"`;
}

// ─── ElevenLabs TTS ────────────────────────────────────────────────────────

async function generateSpeech(text, filename) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs ${response.status}: ${err}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(path.join(audioDir, filename), Buffer.from(buffer));
}

// ─── Claude AI ─────────────────────────────────────────────────────────────

async function getAIResponse(callSid, userMessage) {
  if (!conversations[callSid]) conversations[callSid] = [];
  conversations[callSid].push({ role: 'user', content: userMessage });

  const result = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: buildSystemPrompt(BUSINESS_NAME),
    messages: conversations[callSid],
  });

  const reply = result.content[0].text;
  conversations[callSid].push({ role: 'assistant', content: reply });
  return reply;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function parseBooking(reply) {
  const match = reply.match(/\[BOOKING: ([^\]]+)\]/);
  if (!match) return null;
  const raw = match[1];
  const get = (key) => {
    const m = raw.match(new RegExp(`${key}="([^"]+)"`));
    return m ? m[1] : '';
  };
  return {
    name: get('name'),
    phone: get('phone'),
    issue: get('issue'),
    location: get('location'),
  };
}

function playText(twiml, text) {
  twiml.say({ voice: 'Polly.Joanna-Neural', language: 'en-US' }, text);
}

async function playElevenLabs(twiml, text, callSid) {
  const filename = `${callSid}-${Date.now()}.mp3`;
  await generateSpeech(text, filename);
  twiml.play(`${BASE_URL}/audio/${filename}`);
}

function cleanReply(reply) {
  return reply
    .replace(/\[BOOKING:[^\]]*\]/g, '')
    .replace(/\[END\]/g, '')
    .trim();
}

async function sendSMSConfirmation(booking) {
  const customerBody =
    `Hi ${booking.name}, here's a summary of your call with ${BUSINESS_NAME}:\n` +
    `Issue: ${booking.issue}\n` +
    `Location: ${booking.location}\n` +
    `Someone will follow up with you as soon as possible.`;

  const ownerBody =
    `New lead from ${BUSINESS_NAME} receptionist:\n` +
    `Name: ${booking.name}\n` +
    `Phone: ${booking.phone}\n` +
    `Issue: ${booking.issue}\n` +
    `Location: ${booking.location}`;

  await Promise.all([
    twilioClient.messages.create({ body: customerBody, from: TWILIO_PHONE_NUMBER, to: booking.phone }),
    twilioClient.messages.create({ body: ownerBody, from: TWILIO_PHONE_NUMBER, to: BUSINESS_PHONE }),
  ]);

  console.log(`📱 SMS sent to customer (${booking.phone}) and owner (${BUSINESS_PHONE})`);
}

async function sendToZapier(booking) {
  if (!ZAPIER_WEBHOOK_URL) return;
  await fetch(ZAPIER_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...booking, business: BUSINESS_NAME, timestamp: new Date().toISOString() }),
  });
  console.log(`⚡ Booking sent to Zapier`);
}

function scheduleAudioCleanup(callSid) {
  setTimeout(() => {
    try {
      fs.readdirSync(audioDir)
        .filter(f => f.startsWith(callSid))
        .forEach(f => fs.unlinkSync(path.join(audioDir, f)));
    } catch {}
  }, 60_000);
}

// ─── Routes ────────────────────────────────────────────────────────────────

// Twilio calls this when an incoming call arrives
app.post('/call/incoming', async (req, res) => {
  const callSid = req.body.CallSid;
  const twiml = new twilio.twiml.VoiceResponse();

  console.log(`📞 Incoming call [${callSid}]`);

  const greeting = `Hi, you've reached ${BUSINESS_NAME}. How can I help you today?`;
  await playElevenLabs(twiml, greeting, callSid);

  twiml.gather({
    input: 'speech',
    action: '/call/respond',
    method: 'POST',
    speechTimeout: 'auto',
    timeout: 20,
    language: 'en-US',
  });

  res.type('text/xml').send(twiml.toString());
});

// Twilio calls this with the caller's transcribed speech
app.post('/call/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new twilio.twiml.VoiceResponse();

  console.log(`🗣  [${callSid}] Caller: "${speech}"`);

  // Nothing heard for 20s — end the call gracefully
  if (!speech) {
    await playElevenLabs(twiml, "We didn't hear anything. Feel free to call back anytime. Take care!", callSid);
    twiml.hangup();
    delete conversations[callSid];
    return res.type('text/xml').send(twiml.toString());
  }

  // Get AI response
  let aiReply;
  try {
    aiReply = await getAIResponse(callSid, speech);
  } catch (err) {
    console.error('❌ AI error:', err.message);
    playText(twiml, "I'm sorry, there was a technical issue. Please call back shortly.");
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`🤖 [${callSid}] Receptionist: "${aiReply}"`);

  // Handle booking signal
  const booking = parseBooking(aiReply);
  if (booking) {
    console.log('📅 BOOKING:', JSON.stringify(booking, null, 2));
    sendSMSConfirmation(booking).catch(err =>
      console.error('❌ SMS failed:', err.message)
    );
    sendToZapier(booking).catch(err =>
      console.error('❌ Zapier failed:', err.message)
    );
  }

  const shouldEnd = aiReply.includes('[END]') || !!booking;
  const text = cleanReply(aiReply);

  await playElevenLabs(twiml, text, callSid);

  if (shouldEnd) {
    twiml.hangup();
    delete conversations[callSid];
    scheduleAudioCleanup(callSid);
  } else {
    twiml.gather({
      input: 'speech',
      action: '/call/respond',
      method: 'POST',
      speechTimeout: 'auto',
      timeout: 20,
      language: 'en-US',
    });
  }

  res.type('text/xml').send(twiml.toString());
});

// ─── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🦞 Receptionist server running`);
  console.log(`   Business : ${BUSINESS_NAME}`);
  console.log(`   Port     : ${PORT}`);
  console.log(`   Public   : ${BASE_URL}`);
  console.log(`   Webhook  : ${BASE_URL}/call/incoming\n`);
});
