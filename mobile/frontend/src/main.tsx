import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import Home from "./pages/Home.js";
import ClaimQR from "./pages/ClaimQR.js";
import RegisterProvider from "./pages/RegisterProvider.js";
import Dashboard from "./pages/Dashboard.js";
import Chat from "./pages/Chat.js";
import MerchantScan from "./pages/MerchantScan.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/register-provider" element={<RegisterProvider />} />
          <Route path="/dashboard" element={<Dashboard />} />
          {/* Public transparency page: API/chain health + recent sanitized
              activity. No auth, no sensitive data — safe to link publicly. */}
          <Route path="/status" element={<Status />} />
          {/* Standalone QR page — this is the link the API's cash_request
              endpoint returns, and it must work with no app install and
              no login, since agents (Claude, Telegram, WhatsApp) paste it
              directly into chat. */}
          <Route path="/claim/:id" element={<ClaimQR />} />
          <Route path="/chat/:tradeId" element={<Chat />} />
          <Route path="/merchant/scan" element={<MerchantScan />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
