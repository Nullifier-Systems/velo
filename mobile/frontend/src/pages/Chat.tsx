import { useState } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useChat } from "../hooks/useChat";
import { shortAddress } from "../lib/api";
import "./Chat.css";

export default function Chat() {
  const { t } = useTranslation();
  const { tradeId } = useParams<{ tradeId: string }>();
  const [searchParams] = useSearchParams();
  const participant = searchParams.get("participant") ?? "";
  const navigate = useNavigate();

  const [input, setInput] = useState("");
  const { messages, send, connected, closed, canSend, safetyNumber, keyChanged, acknowledgeKeyChange } = useChat({
    tradeId: tradeId ?? "",
    participant,
  });

  if (!tradeId) {
    return (
      <div className="chat-page">
        <p className="chat-empty">{t("chat.noTradeId")}</p>
      </div>
    );
  }

  if (closed) {
    return (
      <div className="chat-page">
        <div className="chat-card">
          <div className="chat-closed">
            <p>{t("chat.conversationEnded")}</p>
            <button className="chat-back" onClick={() => navigate(-1)}>{t("common.back")}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-page">
      <div className="chat-card">
        <div className="chat-header">
          <span className="chat-trade-label">{t("chat.trade")} {shortAddress(tradeId)}</span>
          <span className={`chat-status ${connected ? "chat-status--online" : "chat-status--offline"}`}>
            {connected ? t("chat.connected") : t("chat.connecting")}
          </span>
        </div>

        <div className="chat-encryption-bar">
          <span className="chat-encryption-badge">🔒 End-to-end encrypted</span>
          {safetyNumber && <span className="chat-safety-number" title="Compare this code with the other participant in person to confirm your connection hasn't been tampered with.">{safetyNumber}</span>}
        </div>

        {keyChanged && (
          <div className="chat-key-warning">
            <p>⚠️ The other participant's security code changed. Verify it matches before continuing.</p>
            <button className="chat-key-warning__ack" onClick={acknowledgeKeyChange}>I've verified, continue</button>
          </div>
        )}

        <div className="chat-messages" role="log" aria-live="polite">
          {messages.length === 0 && (
            <p className="chat-empty">{t("chat.noMessages")}</p>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`chat-bubble ${msg.sender === participant ? "chat-bubble--self" : "chat-bubble--other"}`}
            >
              <span className="chat-bubble__sender">{shortAddress(msg.sender)}</span>
              <p className="chat-bubble__text">
                {msg.text ?? <em className="chat-bubble__undecryptable">Unable to decrypt this message.</em>}
              </p>
              <span className="chat-bubble__time">
                {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>

        <form
          className="chat-input-area"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) {
              send(input.trim());
              setInput("");
            }
          }}
        >
          <input
            className="chat-input"
            type="text"
            placeholder={t("chat.typeMessage")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!canSend}
          />
          <button className="chat-send" type="submit" disabled={!connected || !input.trim()}>
            {t("chat.send")}
          </button>
        </form>
      </div>
    </div>
  );
}
