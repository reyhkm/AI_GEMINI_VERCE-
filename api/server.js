require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const uuid = require('uuid');
const axios = require('axios');
const moment = require('moment-timezone');
const { marked } = require('marked');

// Import Gemini API SDK dan inisialisasi dengan API key secara hardcoded (hanya untuk development!)
const { GoogleGenerativeAI } = require('@google/generative-ai');
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

// Tangani permintaan favicon agar tidak error
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

/*
  Fungsi utama untuk chat dengan asisten pribadi menggunakan Gemini API.
  Dilengkapi dengan retry logic dan update history percakapan.
*/
async function chatWithAssistant(userId, message, maxRetries = 5, initialDelay = 1000) {
  let history = getConversationHistory(userId);
  console.log("History sebelum dikirim:", JSON.stringify(history));

  // Persiapkan system instruction. Perhatikan penggunaan getJakartaTime() untuk waktu saat ini.
  const systemInstructionText = `
* **Prioritaskan jawaban yang SANGAT singkat, padat, jelas, dan menarik.**

GUNAKAN MARKDOWN YANG DIPERLUKANN!!!

Nama kamu adalah : Sera  
Kamu adalah asisten AI yang sangat profesional dan ramah, tugasmu adalah memberikan informasi tentang Reykal, merespons pertanyaan, dan menerima pesan untuknya.

**Gaya Jawaban:**
* **Profesional dan Ramah:** Jawab dengan sopan, antusias, dan gunakan bahasa yang lugas namun tetap bersahabat.
* **Singkat, Jelas, Padat:** Berikan informasi langsung ke intinya tanpa bertele-tele.
* **Menarik:** Gunakan **bold** untuk membuat respons lebih menarik dan tambahkan sedikit pemanis.
* **Selalu Tersenyum:** Akhiri jawaban dengan emoji senyum (😊, 😄, 👍).

Saat ini adalah ${getJakartaTime()}.

**Informasi Tentang Reykal:**
* **Nama Lengkap:** Reykal Hizbullah Al-Hikam  
* **Tempat Tinggal:** Kota Depok  
* **Umur:** 21 Tahun  
* **Instagram:** @reyhkm  
* **Email:** reyhikam04@gmail.com  
* **Nomor Handphone:** +6289636153854  
* **Alamat:** Jl. Adam Blok Haji Midin, Tugu, Cimanggis, Kota Depok, Jawa Barat  
* **Tanggal Lahir:** 16 Maret 2004  
* **Tempat Lahir:** Jakarta  
* **Pacar:** Jihan Rizki  
* **Alamat Pacar:** Cileunyi, Bandung  
* **Jenis Kelamin:** Laki-laki  
* **Pendidikan:** S1 Informatika, Universitas Gunadarma (Semester 6, IPK 3.75)  
* **Keahlian:**  
  * **Hard Skills:** Data Analysis, Excel tingkat lanjut, SQL  
  * **Soft Skills:** Problem-solving, Communication, Empati, Kreativitas, Kejujuran, Berpikiran terbuka  
* **Visi & Misi:** Mengasah kemampuan untuk membangun masa depan yang lebih baik melalui teknologi.
`;

  const generationConfig = {
    temperature: 0,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    responseMimeType: "text/plain"
  };

  const contents = [
    ...history,
    { role: 'user', parts: [{ text: message }] }
  ];

  console.log("Payload dikirim:", JSON.stringify({ contents, generationConfig }, null, 2));

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let response = await genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        systemInstruction: systemInstructionText,
      }).generateContent({
        contents,
        generationConfig,
      });
      console.log("Raw response:", JSON.stringify(response, null, 2));

      if (response.response && response.response.candidates && response.response.candidates.length > 0) {
        const candidate = response.response.candidates[0].content;
        const candidateText = candidate.parts.map(p => p.text).join("\n").trim();
        history.push({ role: 'user', parts: [{ text: message }] });
        history.push(candidate);
        saveConversationHistory(userId, history);
        return marked(candidateText);
      } else {
        throw new Error("Response dari Gemini API tidak valid.");
      }
    } catch (error) {
      console.error(`Percobaan ke-${attempt + 1} gagal:`, error);
      if (error.message && (error.message.includes("503") || error.message.includes("overloaded"))) {
        if (attempt < maxRetries - 1) {
          const delay = initialDelay * (attempt + 1);
          console.log(`Menunggu ${delay/1000} detik untuk mencoba lagi...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } else {
        return "Maaf, terjadi masalah: " + error.message;
      }
    }
  }
  return "Maaf, sudah mencoba beberapa kali tapi gagal. Coba lagi nanti.";
}

/*
  Endpoint /chat menggunakan pendekatan callback.
  Klien perlu mengirimkan:
    - chat      : Pesan yang ingin diproses.
    - callbackUrl : URL untuk menerima respons akhir.
  
  API ini segera mengembalikan respons bahwa permintaan telah diterima,
  lalu memproses chat secara asinkron dan mengirimkan hasilnya ke callbackUrl.
*/
app.post('/chat', async (req, res) => {
  const { userId, isNew } = getOrCreateUserId(req, res);
  const { chat, callbackUrl } = req.body;
  console.log(`User ${userId} mengirim pesan: ${chat}`);

  if (!chat || !callbackUrl) {
    return res.status(400).json({ message: "Parameter 'chat' dan 'callbackUrl' harus disediakan." });
  }

  // Respon segera ke klien untuk menghindari timeout
  res.status(200).json({ message: "Permintaan diterima. Memproses, hasil akan dikirimkan melalui callback." });

  // Proses background yang memanggil Gemini API dan mengirim callback
  try {
    const result = await chatWithAssistant(userId, chat);
    await axios.post(callbackUrl, { response: result });
    console.log(`Callback berhasil dikirim ke ${callbackUrl}`);
  } catch (error) {
    console.error("Error saat memproses chat:", error.message);
    try {
      await axios.post(callbackUrl, { error: error.message });
    } catch (err) {
      console.error("Gagal mengirim callback error:", err.message);
    }
  }
});

// (Opsional) Endpoint untuk halaman index jika file index.html tersedia
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Mulai server di port yang ditentukan
const PORT = process.env.PORT || 9000;
app.listen(PORT, () => {
  console.log(`Server berjalan pada port ${PORT}`);
});
