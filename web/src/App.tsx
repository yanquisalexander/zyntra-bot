import { Route, Routes } from "react-router-dom";
import AppShell from "@/components/layout/AppShell";
import Dashboard from "@/pages/Dashboard";
import Plugins from "@/pages/Plugins";
import Editor from "@/pages/Editor";
import Config from "@/pages/Config";
import Logs from "@/pages/Logs";
import Login from "@/pages/Login";
import Jobs from "@/pages/Jobs";
import PluginTab from "@/pages/PluginTab";
import PluginRoutes from "@/pages/Routes";
import Setup from "@/pages/Setup";

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-xl font-bold">Página no encontrada</h1>
      <p className="text-sm text-muted-foreground">La ruta que buscas no existe en el panel.</p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Fuera del shell: en producción el servidor la sirve antes que la SPA. */}
      <Route path="/login" element={<Login />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/plugins" element={<Plugins />} />
        <Route path="/plugins/:name" element={<Editor />} />
        <Route path="/config" element={<Config />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/routes" element={<PluginRoutes />} />
        <Route path="/setup" element={<Setup mode="page" />} />
        <Route path="/p/:plugin/:tab" element={<PluginTab />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
