import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <main className="home-container">
      <div className="home-card" style={{ textAlign: 'center' }}>
        <h1 className="home-title">404</h1>
        <p className="home-subtitle">Page Not Found</p>
        <div className="home-placeholder">
          <p>The page you are looking for does not exist.</p>
          <Link to="/" style={{ textDecoration: 'none' }}>
            <button className="home-crash-button" style={{ marginTop: '1rem' }}>
              Go Home
            </button>
          </Link>
        </div>
      </div>
    </main>
  );
}
