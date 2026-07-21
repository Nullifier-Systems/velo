import { useState } from 'react';

export default function Home() {
  const [shouldCrash, setShouldCrash] = useState(false);

  if (shouldCrash) {
    throw new Error('Simulated component crash');
  }

  return (
    <main className="home-container">
      <div className="home-card">
        <h1 className="home-title">Velo</h1>
        <p className="home-subtitle">Cash in / cash out — P0 build starts here.</p>
        {/* TODO (Core Retail Flow P0): one identity per device, real
            nearby-provider list from the backend, real wallet balance. */}
        <div className="home-placeholder">
          <p>Scan a Velo QR code to get started.</p>
          <button className="home-crash-button" onClick={() => setShouldCrash(true)}>
            Simulate Crash
          </button>
        </div>
      </div>
    </main>
  );
}
