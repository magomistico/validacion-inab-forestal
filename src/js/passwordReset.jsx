import React, { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";

const INAB_OFFICIAL_LOGO = "https://manejoforestal.inab.gob.gt/img/inab.png";

function PasswordResetScreen({ initialEmail = "", initialResetKey = "" }) {
  const [email, setEmail] = useState(initialEmail);
  const [passwordResetKey, setPasswordResetKey] = useState(initialResetKey);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const hasTokenFromLink = Boolean(initialEmail && initialResetKey);
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let width = window.innerWidth;
    let height = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let time = 0;
    let animId = null;

    let seed = 81923;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const stars = Array.from({ length: 180 }, () => ({
      x: random() * width,
      y: random() * height,
      vx: (random() - 0.5) * 0.2,
      vy: (random() - 0.5) * 0.2,
      r: 0.45 + random() * 1.05,
      phase: random() * Math.PI * 2,
      emerald: random() > 0.45,
    }));

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    window.addEventListener("resize", resize);
    resize();

    const render = () => {
      time += 0.016;
      ctx.clearRect(0, 0, width, height);

      const grad = ctx.createRadialGradient(
        width / 2,
        height / 2,
        20,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.45
      );
      grad.addColorStop(0, "rgba(77, 152, 96, 0.08)");
      grad.addColorStop(0.5, "rgba(22, 83, 55, 0.03)");
      grad.addColorStop(1, "rgba(6, 7, 6, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        s.x += s.vx;
        s.y += s.vy;
        if (s.x < 0) s.x = width;
        if (s.x > width) s.x = 0;
        if (s.y < 0) s.y = height;
        if (s.y > height) s.y = 0;

        ctx.fillStyle = s.emerald ? "#9ed999" : "#edf9eb";
        ctx.globalAlpha = 0.14 + 0.32 * Math.sin(time * 1.5 + s.phase);
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => {
      if (animId) cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");

    if (password.length < 6) {
      setErrorMsg("La contraseña debe tener al menos 6 caracteres.");
      return;
    }
    if (password !== passwordConfirmation) {
      setErrorMsg("La contraseña y su confirmación no coinciden.");
      return;
    }

    setLoading(true);
    fetch("/password-reset", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: email.trim(),
        passwordResetKey: passwordResetKey.trim(),
        password,
        passwordConfirmation,
      }),
    })
      .then((response) => Promise.all([response.ok, response.json()]))
      .then(([ok, data]) => {
        setLoading(false);
        if (ok && data === "") {
          setSuccessMsg(
            "¡Tu contraseña ha sido actualizada correctamente! Ya puedes iniciar sesión con tu nueva clave."
          );
          window.setTimeout(() => {
            window.location.assign("/login");
          }, 2500);
        } else {
          setErrorMsg(
            typeof data === "string" && data
              ? data
              : "No se pudo restablecer la contraseña."
          );
        }
      })
      .catch(() => {
        setLoading(false);
        setErrorMsg("Error de conexión al servidor. Inténtalo de nuevo.");
      });
  };

  return (
    <div className="inab-auth-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

        html, body, #app {
          margin: 0 !important;
          padding: 0 !important;
          padding-top: 0 !important;
          width: 100%;
          min-height: 100vh;
          background-color: #060706 !important;
          color: #ededed;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          overflow-x: hidden;
        }

        .inab-auth-root {
          position: relative;
          min-height: 100vh;
          width: 100vw;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          background-color: #060706;
          color: #ededed;
        }

        .inab-auth-canvas {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          z-index: 1;
          pointer-events: none;
        }

        .inab-auth-layer {
          position: relative;
          z-index: 10;
        }

        .inab-auth-header {
          width: 100%;
          max-width: 1280px;
          margin: 0 auto;
          padding: 1.5rem 2.5rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .inab-auth-card {
          width: 100%;
          max-width: 440px;
          margin: 1rem auto;
          padding: 2.25rem;
          border-radius: 24px;
          background: rgba(10, 15, 11, 0.85);
          border: 1px solid rgba(114, 184, 121, 0.22);
          backdrop-filter: blur(22px);
          -webkit-backdrop-filter: blur(22px);
          box-shadow: 0 25px 60px rgba(0, 0, 0, 0.7), 0 0 40px rgba(77, 152, 96, 0.08);
        }

        .inab-auth-label {
          display: block;
          font-size: 0.78rem;
          font-weight: 500;
          color: #d4d4d8;
          margin-bottom: 0.4rem;
        }

        .inab-auth-input {
          width: 100%;
          padding: 0.72rem 0.95rem;
          border-radius: 12px;
          background: rgba(6, 8, 7, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.14);
          color: #ffffff;
          font-size: 0.88rem;
          transition: all 0.2s ease;
          margin-bottom: 1rem;
          box-sizing: border-box;
        }

        .inab-auth-input:focus {
          outline: none;
          border-color: #72b879;
          box-shadow: 0 0 0 3px rgba(114, 184, 121, 0.2);
        }

        .inab-auth-account-badge {
          background: rgba(16, 185, 129, 0.1);
          border: 1px solid rgba(114, 184, 121, 0.3);
          color: #bbf7d0;
          border-radius: 10px;
          padding: 0.65rem 0.9rem;
          font-size: 0.82rem;
          margin-bottom: 1.1rem;
          text-align: center;
          word-break: break-all;
        }

        .inab-auth-submit {
          width: 100%;
          padding: 0.82rem 1.25rem;
          border-radius: 12px;
          background: linear-gradient(135deg, #4d9860 0%, #2f6c40 100%);
          border: 1px solid rgba(158, 217, 153, 0.35);
          color: #ffffff;
          font-weight: 600;
          font-size: 0.88rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          transition: all 0.2s ease;
          margin-top: 0.25rem;
        }

        .inab-auth-submit:hover:not(:disabled) {
          background: linear-gradient(135deg, #5eae72 0%, #387e4b 100%);
          transform: translateY(-1px);
          box-shadow: 0 10px 25px rgba(77, 152, 96, 0.32);
        }

        .inab-auth-submit:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }

        .inab-auth-error {
          background: rgba(220, 38, 38, 0.15);
          border: 1px solid rgba(248, 113, 113, 0.35);
          color: #fca5a5;
          padding: 0.75rem 0.95rem;
          border-radius: 10px;
          font-size: 0.8rem;
          margin-bottom: 1rem;
          line-height: 1.45;
        }

        .inab-auth-success {
          background: rgba(16, 185, 129, 0.14);
          border: 1px solid rgba(52, 211, 153, 0.38);
          color: #a7f3d0;
          padding: 0.85rem 1rem;
          border-radius: 10px;
          font-size: 0.82rem;
          margin-bottom: 1rem;
          line-height: 1.5;
        }

        .inab-auth-back {
          color: #d4d4d8 !important;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(0, 0, 0, 0.45);
          border-radius: 9999px;
          padding: 0.48rem 1.1rem;
          font-size: 0.76rem;
          text-decoration: none !important;
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          transition: all 0.2s ease;
        }

        .inab-auth-back:hover {
          color: #ffffff !important;
          border-color: rgba(158, 217, 153, 0.45);
          background: rgba(114, 184, 121, 0.12);
        }
      `}</style>

      <canvas ref={canvasRef} className="inab-auth-canvas" />

      <header className="inab-auth-layer inab-auth-header">
        <a href="/home" style={{ display: "flex", alignItems: "center", gap: "0.6rem", textDecoration: "none" }}>
          <span style={{ fontWeight: 700, letterSpacing: "0.08em", color: "#ffffff", fontSize: "0.9rem" }}>INAB</span>
          <span style={{ color: "rgba(114, 184, 121, 0.6)" }}>/</span>
          <span style={{ color: "#a1a1aa", letterSpacing: "0.08em", fontWeight: 500, fontSize: "0.8rem" }}>SIG</span>
        </a>

        <a href="/login" className="inab-auth-back">
          <span>← Volver a Iniciar Sesión</span>
        </a>
      </header>

      <main className="inab-auth-layer" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
        <div className="inab-auth-card">
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", marginBottom: "1.4rem" }}>
            <img
              src={INAB_OFFICIAL_LOGO}
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.src = "/img/inab-logo.svg";
              }}
              alt="INAB Guatemala"
              style={{
                height: "76px",
                width: "auto",
                objectFit: "contain",
                marginBottom: "0.75rem",
                filter: "drop-shadow(0 0 18px rgba(114, 184, 121, 0.25))",
              }}
            />
            <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: "#ffffff", margin: 0 }}>
              Restablecer Contraseña
            </h1>
            <p style={{ fontSize: "0.8rem", color: "#a1a1aa", margin: "0.45rem 0 0 0", lineHeight: 1.45 }}>
              Define una nueva contraseña para acceder a tu cuenta en INAB · SIG.
            </p>
          </div>

          {errorMsg && <div className="inab-auth-error">{errorMsg}</div>}
          {successMsg && <div className="inab-auth-success">{successMsg}</div>}

          {!successMsg ? (
            <form onSubmit={handleSubmit}>
              {hasTokenFromLink ? (
                <div className="inab-auth-account-badge">
                  Cuenta: <strong>{email}</strong>
                </div>
              ) : (
                <>
                  <div>
                    <label className="inab-auth-label" htmlFor="reset-email">
                      Correo electrónico
                    </label>
                    <input
                      id="reset-email"
                      type="email"
                      required
                      className="inab-auth-input"
                      placeholder="usuario@inab.gob.gt"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="inab-auth-label" htmlFor="reset-token">
                      Código de recuperación
                    </label>
                    <input
                      id="reset-token"
                      type="text"
                      required
                      className="inab-auth-input"
                      placeholder="Pega el código recibido"
                      value={passwordResetKey}
                      onChange={(e) => setPasswordResetKey(e.target.value)}
                    />
                  </div>
                </>
              )}

              <div>
                <label className="inab-auth-label" htmlFor="new-password">
                  Nueva contraseña (mínimo 6 caracteres)
                </label>
                <input
                  id="new-password"
                  type="password"
                  required
                  minLength={6}
                  className="inab-auth-input"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              <div>
                <label className="inab-auth-label" htmlFor="confirm-password">
                  Confirmar nueva contraseña
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  required
                  minLength={6}
                  className="inab-auth-input"
                  placeholder="••••••••"
                  value={passwordConfirmation}
                  onChange={(e) => setPasswordConfirmation(e.target.value)}
                />
              </div>

              <button type="submit" disabled={loading} className="inab-auth-submit">
                <span>{loading ? "Guardando..." : "Guardar nueva contraseña"}</span>
                <span>→</span>
              </button>
            </form>
          ) : (
            <a href="/login" className="inab-auth-submit" style={{ textDecoration: "none" }}>
              <span>Iniciar Sesión</span>
              <span>→</span>
            </a>
          )}

          {!successMsg && (
            <div style={{ marginTop: "1.2rem", textAlign: "center", fontSize: "0.76rem", color: "#a1a1aa" }}>
              ¿El enlace expiró o no funciona?{" "}
              <a href="/password-request" style={{ color: "#9ed999", textDecoration: "none", fontWeight: 500 }}>
                Solicitar uno nuevo
              </a>
            </div>
          )}
        </div>
      </main>

      <footer
        className="inab-auth-layer"
        style={{
          width: "100%",
          maxWidth: "1280px",
          margin: "0 auto",
          padding: "1.25rem 2.5rem",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          gap: "1rem",
          fontSize: "0.72rem",
          color: "#71717a",
        }}
      >
        <span>Instituto Nacional de Bosques (INAB) · Guatemala</span>
        <span>
          Basado en Collect Earth Online y Open Foris ·{" "}
          <strong style={{ color: "#e4e4e7", fontWeight: 500 }}>Updated by Marlon R. Vásquez</strong>
        </span>
      </footer>
    </div>
  );
}

export function pageInit(params) {
  ReactDOM.render(
    <PasswordResetScreen
      initialEmail={params.email || ""}
      initialResetKey={params.passwordResetKey || ""}
    />,
    document.getElementById("app")
  );
}
