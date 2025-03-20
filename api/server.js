require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { marked } = require('marked');

// Import Gemini API SDK dan hardcode API key (development purpose only)
const { GoogleGenerativeAI } = require('@google/generative-ai');
// Hardcoded API key (gunakan dengan hati-hati, terutama di production)
const genAI = new GoogleGenerativeAI("AIzaSyDMA2pw9dzbdkjkOb9hrieDxks7rhA4_BA");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const allowedOrigins = [
  "https://rey.is-great.net",
  "https://reyhkm.pages.dev",
  "https://rey.wuaze.com",
  "https://aisera.pages.dev"
];
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

app.get('/favicon.ico', (req, res) => res.status(204).end());

// Simulasi database untuk history percakapan
const userConversations = {};

function getJakartaTime() {
  return moment().tz("Asia/Jakarta").format("dddd, DD MMMM YYYY, HH:mm:ss [WIB]");
}

function getOrCreateUserId(req, res) {
  let userId = req.cookies.user_id;
  let isNew = false;
  if (!userId) {
    userId = uuid.v4();
    isNew = true;
  }
  return { userId, isNew };
}

function getConversationHistory(userId) {
  return userConversations[userId] || [];
}

function saveConversationHistory(userId, history) {
  userConversations[userId] = history;
}

async function chatWithAssistant(userId, message, maxRetries = 5, initialDelay = 1000) {
  let history = getConversationHistory(userId);
  console.log("History sebelum dikirim:", JSON.stringify(history));

  const systemInstructionText = `
* **Prioritaskan jawaban yang SANGAT singkat, padat, jelas, dan menarik.**

GUNAKAN MARKDOWN YANG DIPERLUKANN!!!

Nama kamu adalah : Sera  
Kamu adalah asisten AI yang sangat profesional dan ramah, tugasmu adalah memberikan informasi tentang Reykal, merespons pertanyaan, dan menerima pesan untuknya.

**Gaya Jawaban:**
* **Profesional & Ramah:** Jawab dengan sopan dan antusias.
* **Singkat, Jelas, Padat:** Informasi langsung ke intinya (maksimal 3-4 kalimat).
* **Menarik:** Gunakan **bold** dan sedikit "pemanis" dalam jawaban.
* **Selalu Tersenyum:** Akhiri jawaban dengan emoji (😊, 😄, 👍).

Saat ini adalah ${getJakartaTime()} WIB.

**Informasi Tentang Reykal:**
* **Nama Lengkap:** Reykal Hizbullah Al-Hikam  
... (dan seterusnya sesuai kebutuhan) ...
`;

  const generationConfig = {
    temperature: 0,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    responseMimeType: "text/plain",
  };

  const contents = [
    ...history,
    { role: 'user', parts: [{ text: message }] }
  ];

  console.log("Payload yang dikirim:", JSON.stringify({ contents, generationConfig }, null, 2));

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let response = await genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        systemInstruction: systemInstructionText,
      }).generateContent({
        contents,
        generationConfig,
      });

      console.log("Raw response dari Gemini:", JSON.stringify(response, null, 2));

      if (response.response && response.response.candidates && response.response.candidates.length > 0) {
        const candidate = response.response.candidates[0].content;
        const candidateText = candidate.parts.map(p => p.text).join("\n").trim();
        history.push({ role: 'user', parts: [{ text: message }] });
        history.push(candidate);
        saveConversationHistory(userId, history);
        return marked(candidateText);
      } else {
        throw new Error("Response from Gemini API is invalid.");
      }
    } catch (error) {
      console.error(`Percobaan ke-${attempt + 1} gagal:`, error);
      if (error.message && (error.message.includes("503") || error.message.includes("overloaded"))) {
        if (attempt < maxRetries - 1) {
          const delay = initialDelay * (attempt + 1);
          console.log(`Tunggu ${delay / 1000} detik sebelum mencoba lagi...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } else {
        return "Maaf, ada masalah: " + error.message;
      }
    }
  }
  return "Maaf, sudah mencoba beberapa kali tapi masih gagal. Coba lagi nanti.";
}

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.post('/chat', async (req, res) => {
  const { userId, isNew } = getOrCreateUserId(req, res);
  const userMessage = req.body.chat;
  console.log(`User ID: ${userId}, Message: ${userMessage}`);

  const botResponse = await chatWithAssistant(userId, userMessage);

  if (isNew) {
    res.cookie('user_id', userId, {
      path: '/chat',
      secure: true,
      httpOnly: true,
      sameSite: 'None',
      maxAge: 600000 // 10 menit
    });
  }
  res.json({ response: botResponse });
});

// Jika dijalankan secara lokal, mulai server seperti biasa
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 9000;
  app.listen(PORT, () => {
    console.log(`Server berjalan pada port ${PORT}`);
  });
}

const serverless = require('serverless-http');
// Ekspor fungsi serverless sebagai default export yang valid untuk Vercel
module.exports = serverless(app);
