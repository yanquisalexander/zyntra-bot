/**
 * Login page standalone: se sirve directo desde el servidor (sin SPA ni
 * assets compilados) para que un visitante sin sesión vea el login en la
 * primera pintura, sin flash del dashboard ni saltos a Discord.
 */
export function renderLoginPage(error?: string): string {
  const forbidden =
    error === "forbidden"
      ? `<p class="err">Esa cuenta no tiene permiso. Pide acceso al admin. 🔒</p>`
      : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Zyntra Bot — entra a tu panel">
<title>Entrar · ZyntraBot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: #0d0d0d;
    color: #f0eeea;
    font-family: "Nunito", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: 400px;
    text-align: center;
    background: #161616;
    border: 1px solid #242424;
    border-radius: 24px;
    padding: 40px 32px;
  }
  .bot {
    width: 84px;
    height: 84px;
    margin: 0 auto 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 44px;
    background: #a78bfa;
    animation: morph 9s ease-in-out infinite;
  }
  @keyframes morph {
    0%, 100% { border-radius: 30% 70% 62% 38% / 46% 42% 58% 54%; }
    33% { border-radius: 62% 38% 44% 56% / 56% 64% 36% 44%; }
    66% { border-radius: 44% 56% 68% 32% / 62% 36% 64% 38%; }
  }
  .brand {
    font-family: "Fredoka", sans-serif;
    font-size: 17px;
    font-weight: 600;
  }
  .brand span { color: #a78bfa; }
  h1 {
    font-family: "Fredoka", sans-serif;
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 10px 0 8px;
  }
  .sub { color: #948d81; font-size: 14.5px; line-height: 1.65; margin-bottom: 24px; }
  .err {
    border: 1px solid #ff5e5b33;
    background: #ff5e5b11;
    color: #ff7a78;
    font-size: 13px;
    font-weight: 700;
    border-radius: 12px;
    padding: 10px 14px;
    margin-bottom: 16px;
  }
  .discord-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    height: 52px;
    background: #5865f2;
    color: #fff;
    font-family: "Nunito", sans-serif;
    font-size: 15px;
    font-weight: 800;
    text-decoration: none;
    border-radius: 14px;
    transition: background 150ms ease-out, transform 150ms ease-out;
  }
  .discord-btn:hover { background: #6e7aff; }
  .discord-btn:active { transform: scale(0.98); }
  .tiny { margin-top: 18px; color: #6b655a; font-size: 12px; font-weight: 700; }
  .foot { margin-top: 26px; color: #3a352f; font-size: 12px; font-weight: 700; }
  @media (prefers-reduced-motion: reduce) {
    .bot { animation: none; border-radius: 28%; }
  }
</style>
</head>
<body>
  <main class="card">
    <div class="bot">🤖</div>
    <p class="brand">Zyntra<span>Bot</span></p>
    <h1>Pasa al panel</h1>
    <p class="sub">Conéctate con Discord para manejar tu bot.<br>Solo admins, sin contraseñas. ✨</p>
    ${forbidden}
    <a class="discord-btn" href="/api/auth/login">
      <svg viewBox="0 0 256 199" width="20" height="16" fill="currentColor" aria-hidden="true"><path d="M216.856 16.597A208.502 208.502 0 0 0 164.042 0c-2.275 4.113-4.933 9.645-6.766 14.046-19.692-2.961-39.203-2.961-58.533 0-1.832-4.4-4.55-9.933-6.846-14.046a207.809 207.809 0 0 0-52.855 16.638C5.618 67.147-3.443 116.4 1.087 164.956c22.169 16.555 43.653 26.612 64.775 33.193A161.094 161.094 0 0 0 79.735 175.3a136.413 136.413 0 0 1-21.846-10.632 108.636 108.636 0 0 0 5.356-4.237c42.122 19.702 87.89 19.702 129.51 0a131.66 131.66 0 0 0 5.355 4.237 136.07 136.07 0 0 1-21.886 10.653c4.006 8.02 8.638 15.67 13.873 22.848 21.142-6.58 42.646-16.637 64.815-33.213 5.316-56.288-9.08-105.09-38.056-148.36ZM85.474 135.095c-12.645 0-23.015-11.805-23.015-26.18s10.149-26.2 23.015-26.2c12.867 0 23.236 11.804 23.015 26.2.02 14.375-10.148 26.18-23.015 26.18Zm85.051 0c-12.645 0-23.014-11.805-23.014-26.18s10.148-26.2 23.014-26.2c12.867 0 23.236 11.804 23.015 26.2 0 14.375-10.148 26.18-23.015 26.18Z"/></svg>
      Continuar con Discord
    </a>
    <p class="tiny">Solo cuentas autorizadas · Sin contraseñas</p>
    <p class="foot">Hecho de noche, con ☕</p>
  </main>
</body>
</html>`;
}
