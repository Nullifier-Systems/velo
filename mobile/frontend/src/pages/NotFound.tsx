import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function NotFound() {
  const { t } = useTranslation();

  return (
    <main className="home-container">
      <div className="home-card" style={{ textAlign: "center" }}>
        <h1 className="home-title">{t("notFound.title")}</h1>
        <p className="home-subtitle">{t("notFound.subtitle")}</p>
        <div className="home-placeholder">
          <p>{t("notFound.description")}</p>
          <Link to="/" style={{ textDecoration: "none" }}>
            <button className="home-crash-button" style={{ marginTop: "1rem" }}>
              {t("notFound.goHome")}
            </button>
          </Link>
        </div>
      </div>
    </main>
  );
}
