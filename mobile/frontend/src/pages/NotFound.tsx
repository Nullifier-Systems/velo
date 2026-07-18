import { Link } from "react-router-dom";
import "./NotFound.css";

export default function NotFound() {
  return (
    <main className="not-found-container">
      <div className="not-found-card">
        <h1 className="not-found-code">404</h1>
        <p className="not-found-title">Page not found</p>
        <p className="not-found-subtitle">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link to="/" className="not-found-link">
          Back to home
        </Link>
      </div>
    </main>
  );
}
