import React from "react";

interface SecurityFingerprintModalProps {
  isOpen: boolean;
  onClose: () => void;
  safetyNumber: string | null;
  peerAddress: string;
}

export const SecurityFingerprintModal: React.FC<SecurityFingerprintModalProps> = ({
  isOpen,
  onClose,
  safetyNumber,
  peerAddress,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400 text-xl">🔒</span>
            <h3 className="text-lg font-bold text-white">Security Fingerprint</h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        <p className="text-sm text-slate-300 mb-6">
          Compare this safety number out loud or side-by-side with your peer (
          <span className="font-mono text-emerald-300">{peerAddress.slice(0, 6)}…{peerAddress.slice(-6)}</span>
          ) to verify end-to-end encryption integrity and prevent machine-in-the-middle attacks.
        </p>

        <div className="bg-slate-950 border border-slate-800 rounded-xl p-6 text-center mb-6">
          <div className="text-2xl font-mono tracking-widest font-bold text-emerald-400 select-all">
            {safetyNumber ?? "CALCULATING..."}
          </div>
          <div className="text-xs text-slate-500 mt-2">
            Signal Double Ratchet Constant-Time Safety Number
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 font-semibold text-slate-950 transition-colors"
          >
            Verified & Done
          </button>
        </div>
      </div>
    </div>
  );
};
