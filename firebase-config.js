// Firebase yapılandırması
// Firebase Console → Project Settings → General → Firebase SDK snippet → Config kısmından alıp buraya yapıştırın
const firebaseConfig = {
  apiKey: "AIzaSyAIyoomgTQvbs2ayPGfM6dGRXGvA_DeZHE",
  authDomain: "myflix-gallery.firebaseapp.com",
  projectId: "myflix-gallery",
  storageBucket: "myflix-gallery.firebasestorage.app",
  messagingSenderId: "22753471596",
  appId: "1:22753471596:web:1a4a855da8e7d23aeb3c49",
  measurementId: "G-EHMFSZK836"
};

// Firebase'i başlat
firebase.initializeApp(firebaseConfig);

// Servisleri al
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();
