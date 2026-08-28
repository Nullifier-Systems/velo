import React, { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useE2eeChat } from "../hooks/useE2eeChat";
import { SecurityFingerprintModal } from "./SecurityFingerprintModal";
import { EncryptedMediaViewer } from "./EncryptedMediaViewer";

interface EncryptedChatDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  tradeId: string;
  ownAddress: string;
  peerAddress: string;
  token: string;
}

export const EncryptedChatDrawer: React.FC<EncryptedChatDrawerProps> = ({
  isOpen,
  onClose,
  tradeId,
  ownAddress,
  peerAddress,
  token,
}) => {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState("");
  const [showFingerprintModal, setShowFingerprintModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    messages,
    sendTextMessage,
    sendMediaFile,
    canSend,
    safetyNumber,
  } = useE2eeChat({
    tradeId,
    ownAddress,
    peerAddress,
    token,
  });

  if (!isOpen) return null;

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !canSend) return;
    sendTextMessage(inputText.trim());
    setInputText("");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && canSend) {
      sendMediaFile(file);
    }
  };

  const shortPeer = `${peerAddress.slice(0, 6)}…${peerAddress.slice(-4)}`;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-slate-950 border-l border-slate-800 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/50">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <h2 className="font-bold text-white text-base">{t("e2ee.tradeChat")}</h2>
              <span className="text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                {t("e2ee.protocolBadge")}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {t("e2ee.peerLabel", { address: shortPeer })}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFingerprintModal(true)}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-emerald-400 transition-colors"
              title={t("e2ee.verifyFingerprint")}
            >
              {t("e2ee.safetyCode")}
            </button>
            <button onClick={onClose} className="p-2 text-slate-400 hover:text-white">
              ✕
            </button>
          </div>
        </div>

        {/* Message History */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
              <span className="text-3xl mb-2">🔐</span>
              <p className="text-sm font-medium text-slate-400">
                {t("e2ee.sessionInitialized")}
              </p>
              <p className="text-xs mt-1 text-slate-500">
                {t("e2ee.sessionDescription")}
              </p>
            </div>
          ) : (
            messages.map((msg) => {
              const isOwn = msg.sender === ownAddress;
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                      isOwn
                        ? "bg-emerald-600 text-white rounded-br-none"
                        : "bg-slate-800 text-slate-100 rounded-bl-none border border-slate-700/50"
                    }`}
                  >
                    {msg.media ? (
                      <EncryptedMediaViewer
                        dataUrl={msg.media.dataUrl}
                        mimeType={msg.media.mimeType}
                      />
                    ) : (
                      <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-500 mt-1 px-1">
                    {new Date(msg.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Input Bar */}
        <form onSubmit={handleSendText} className="p-4 border-t border-slate-800 bg-slate-900/50">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/*"
            className="hidden"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canSend}
              className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-50 transition-colors"
              title={t("e2ee.sendMediaTitle")}
            >
              📷
            </button>

            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={canSend ? t("chat.typeMessage") : t("chat.connecting")}
              disabled={!canSend}
              className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors"
            />

            <button
              type="submit"
              disabled={!canSend || !inputText.trim()}
              className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-slate-950 font-semibold text-sm transition-colors"
            >
              {t("e2ee.send")}
            </button>
          </div>
        </form>
      </div>

      <SecurityFingerprintModal
        isOpen={showFingerprintModal}
        onClose={() => setShowFingerprintModal(false)}
        safetyNumber={safetyNumber}
        peerAddress={peerAddress}
      />
    </>
  );
};
