import { useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useChat } from '../hooks/useChat';
import { shortAddress } from '../lib/api';
import './Chat.css';

export default function Chat() {
  const { tradeId } = useParams<{ tradeId: string }>();
  const [searchParams] = useSearchParams();
  const participant = searchParams.get('participant') ?? '';
  const navigate = useNavigate();

  const [input, setInput] = useState('');
  const { messages, send, connected, closed } = useChat({
    tradeId: tradeId ?? '',
    participant,
  });

  if (!tradeId) {
    return (
      <div className="chat-page">
        <p className="chat-empty">No trade ID specified.</p>
      </div>
    );
  }

  if (closed) {
    return (
      <div className="chat-page">
        <div className="chat-card">
          <div className="chat-closed">
            <p>This conversation has ended.</p>
            <button className="chat-back" onClick={() => navigate(-1)}>
              Go back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-page">
      <div className="chat-card">
        <div className="chat-header">
          <span className="chat-trade-label">Trade {shortAddress(tradeId)}</span>
          <span
            className={`chat-status ${connected ? 'chat-status--online' : 'chat-status--offline'}`}
          >
            {connected ? 'Connected' : 'Connecting...'}
          </span>
        </div>

        <div className="chat-messages" role="log" aria-live="polite">
          {messages.length === 0 && <p className="chat-empty">No messages yet. Say hello!</p>}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`chat-bubble ${msg.sender === participant ? 'chat-bubble--self' : 'chat-bubble--other'}`}
            >
              <span className="chat-bubble__sender">{shortAddress(msg.sender)}</span>
              <p className="chat-bubble__text">{msg.text}</p>
              <span className="chat-bubble__time">
                {new Date(msg.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
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
              setInput('');
            }
          }}
        >
          <input
            className="chat-input"
            type="text"
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!connected}
          />
          <button className="chat-send" type="submit" disabled={!connected || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
