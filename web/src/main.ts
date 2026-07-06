import * as Sentry from "@sentry/svelte";
import App from "./App.svelte";
import { mount } from "svelte";
import "./app.css";

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.PROD ? "production" : "development",
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    tracesSampleRate: 0.15,
    tracePropagationTargets: [window.location.origin],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}

const app = mount(App, { target: document.getElementById("app")! });

export default app;
