// src/firebase.js

import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
// Si usás Firestore en vez de Realtime Database:
// import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "insumos-panol.firebaseapp.com",
  databaseURL: "https://insumos-panol-default-rtdb.firebaseio.com",
  projectId: "insumos-panol",
  storageBucket: "insumos-panol.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};

// Inicializar Firebase
const app = initializeApp(firebaseConfig);

// Realtime Database
export const db = getDatabase(app);

// Si usaras Firestore:
// export const db = getFirestore(app);

export default app;
