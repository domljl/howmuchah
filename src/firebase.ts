import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";

const values = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = Object.values(values).every(Boolean);
const app = firebaseConfigured ? initializeApp(values) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
let functionsEmulatorConnected = false;

if (app && import.meta.env.VITE_USE_EMULATORS === "true") {
  connectAuthEmulator(auth!, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db!, "127.0.0.1", 8080);
}

export async function callFunction<T>(name: string, data: Record<string, unknown> = {}): Promise<T> {
  if (!app) throw new Error("Firebase is not configured.");
  const { connectFunctionsEmulator, getFunctions, httpsCallable } = await import("firebase/functions");
  const client = getFunctions(app, "asia-southeast1");
  if (import.meta.env.VITE_USE_EMULATORS === "true" && !functionsEmulatorConnected) {
    connectFunctionsEmulator(client, "127.0.0.1", 5001);
    functionsEmulatorConnected = true;
  }
  const result = await httpsCallable<Record<string, unknown>, T>(client, name)(data);
  return result.data;
}
