// Firebase yapılandırması
// Firebase Console → Project Settings → General → Firebase SDK snippet → Config kısmından alıp buraya yapıştırın
const firebaseConfig = {
  apiKey: "AIzaSy...YOUR_API_KEY...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};

// Firebase'i başlat
firebase.initializeApp(firebaseConfig);

// Servisleri al
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();
