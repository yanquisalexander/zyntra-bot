import { Link, useSearchParams } from "react-router-dom";

/**
 * Login page del panel (misma cara que la versión standalone del servidor).
 * En producción el servidor sirve la suya antes de que la SPA cargue;
 * esta existe para el dev con HMR (`pnpm dev:web`).
 */
export default function Login() {
  const [params] = useSearchParams();
  const forbidden = params.get("error") === "forbidden";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <main className="w-full max-w-[400px] rounded-3xl border border-border bg-card p-10 text-center">
        <div className="mx-auto mb-5 flex size-[84px] items-center justify-center bg-[#a78bfa] text-[44px] animate-morph">
          🤖
        </div>
        <p className="font-display text-[17px] font-semibold tracking-tight">
          Zyntra<span className="text-[#a78bfa]">Bot</span>
        </p>
        <h1 className="mt-2.5 font-display text-[32px] font-semibold tracking-tight">Pasa al panel</h1>
        <p className="mx-auto mt-2 mb-6 max-w-[300px] text-sm leading-relaxed text-muted-foreground">
          Conéctate con Discord para manejar tu bot.
          <br />
          Solo admins, sin contraseñas. ✨
        </p>
        {forbidden && (
          <p className="mb-4 rounded-xl border border-[#ff5e5b33] bg-[#ff5e5b11] px-3.5 py-2.5 text-[13px] font-bold text-[#ff7a78]">
            Esa cuenta no tiene permiso. Pide acceso al admin. 🔒
          </p>
        )}
        <a
          href="/api/auth/login"
          className="flex h-[52px] w-full items-center justify-center gap-2.5 rounded-xl bg-primary text-[15px] font-extrabold text-white transition-all duration-150 ease-out hover:bg-[#6e7aff] active:scale-[0.98]"
        >
          <svg viewBox="0 0 256 199" width="20" height="16" fill="currentColor" aria-hidden="true">
            <path d="M216.856 16.597A208.502 208.502 0 0 0 164.042 0c-2.275 4.113-4.933 9.645-6.766 14.046-19.692-2.961-39.203-2.961-58.533 0-1.832-4.4-4.55-9.933-6.846-14.046a207.809 207.809 0 0 0-52.855 16.638C5.618 67.147-3.443 116.4 1.087 164.956c22.169 16.555 43.653 26.612 64.775 33.193A161.094 161.094 0 0 0 79.735 175.3a136.413 136.413 0 0 1-21.846-10.632 108.636 108.636 0 0 0 5.356-4.237c42.122 19.702 87.89 19.702 129.51 0a131.66 131.66 0 0 0 5.355 4.237 136.07 136.07 0 0 1-21.886 10.653c4.006 8.02 8.638 15.67 13.873 22.848 21.142-6.58 42.646-16.637 64.815-33.213 5.316-56.288-9.08-105.09-38.056-148.36ZM85.474 135.095c-12.645 0-23.015-11.805-23.015-26.18s10.149-26.2 23.015-26.2c12.867 0 23.236 11.804 23.015 26.2.02 14.375-10.148 26.18-23.015 26.18Zm85.051 0c-12.645 0-23.014-11.805-23.014-26.18s10.148-26.2 23.014-26.2c12.867 0 23.236 11.804 23.015 26.2 0 14.375-10.148 26.18-23.015 26.18Z" />
          </svg>
          Continuar con Discord
        </a>
        <p className="mt-4 text-xs font-bold text-zinc-600">Solo cuentas autorizadas · Sin contraseñas</p>
        <p className="mt-6 text-xs font-bold text-zinc-700">
          <Link to="/" className="hover:text-muted-foreground hover:underline">
            ← Volver
          </Link>
        </p>
      </main>
    </div>
  );
}
