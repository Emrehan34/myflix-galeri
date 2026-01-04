// Firebase yapılandırması (example)
// Gerçek anahtarları Firebase Console → Project Settings → General → Firebase SDK snippet → Config kısmından alıp buraya yapıştırın.
const firebaseConfig = {
  apiKey: "AIzaSy...YOUR_API_KEY...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};

// Firebase SDK'ları yükle (index.html'e eklenecek)
// <script src="https://www.gstatic.com/firebasejs/9.22.1/firebase-app-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/9.22.1/firebase-auth-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/9.22.1/firebase-storage-compat.js"></script>
