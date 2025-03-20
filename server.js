require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { marked } = require('marked');

// Import Gemini API SDK
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inisialisasi Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Konfigurasi CORS
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

// Fungsi utama untuk chat dengan asisten pribadi (dengan linear backoff)
async function chatWithAssistant(userId, message, maxRetries = 5, initialDelay = 1000) {
  let history = getConversationHistory(userId);

  console.log("History sebelum dikirim:", JSON.stringify(history));

  // Prompt system untuk asisten pribadi
  const systemInstructionText = `
*   **Prioritaskan jawaban yang SANGAT singkat, padat, jelas, dan menarik.**

GUNAKAN MARKDOWN YANG DIPERLUKANN!!!

Nama kamu adalah : Sera  
Kamu adalah asisten AI yang sangat profesional dan ramah, tugasmu adalah memberikan informasi tentang Reykal, merespons pertanyaan, dan menerima pesan untuknya.

**Gaya Jawaban:**
*   **Profesional & Ramah:** Jawab dengan sopan dan antusias.
*   **Singkat, Jelas, Padat:** Informasi langsung ke intinya (maksimal 3-4 kalimat).
*   **Menarik (SANGAT PENTING):** Gunakan **bold** dan sedikit "pemanis" dalam jawaban.
*   **Selalu Tersenyum:** Akhiri jawaban dengan emoji (😊, 😄, 👍).

**Format Markdown yang Menarik**

Saat ini adalah ${getJakartaTime()} WIB.

**Informasi Tentang Reykal:**
*   **Nama Lengkap:** Reykal Hizbullah Al-Hikam  
... (selengkapnya sesuai kebutuhan) ...

**Panduan Interaksi:**
1. **Jawab Pertanyaan:** Utamakan jawaban singkat dan informatif dengan Markdown.
2. **Gunakan Bahasa yang Ramah dan Profesional.**
3. **Tawarkan Bantuan:** Tanyakan apakah ada hal lain yang ingin diketahui.
4. **WAJIB Format Markdown & Emoji:** Tambahkan emoji di setiap jawaban.
5. **Tentang Diri AI:** Jelaskan bahwa kamu adalah AI buatan Reykal.

*PENTING:*
Jika pertanyaan di luar konteks, jawab: "Maaf, saya hanya bisa menjawab tentang Reykal 😊."

`;

  // Inisialisasi model dengan system instruction
  const localModel = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: systemInstructionText,
  });

  // Konfigurasi generate content
  const generationConfig = {
    temperature: 0,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    responseMimeType: "text/plain",
  };

  // Payload untuk pesan
  const contents = [
    ...history,
    { role: 'user', parts: [{ text: message }] }
  ];

  console.log("Payload yang dikirim:", JSON.stringify({ contents, generationConfig }, null, 2));

  // --- BAGIAN DENGAN RETRY LOGIC ---
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let response = await localModel.generateContent({
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

// Inisialisasi Gemini API client dengan API key (sebaiknya simpan di environment variable)
const genAI = new GoogleGenerativeAI(process.env.GENERATIVE_API_KEY);

// Endpoint untuk halaman index
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Endpoint /chat
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

// Jalankan server jika dijalankan secara lokal
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 9000;
  app.listen(PORT, () => {
    console.log(`Server berjalan pada port ${PORT}`);
  });
}

// Bungkus aplikasi Express dengan serverless-http
const serverless = require('serverless-http');
module.exports.handler = serverless(app);
