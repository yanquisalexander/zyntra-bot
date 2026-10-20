definePlugin({
  name: "Twitch",
  version: "0.5.2",
  description: "Avisa cuando tus streamers entran en vivo",

  async setup(api) {
    // twurple local (package.json del host, vía api.lib.pkg) con plan B
    // esm.sh (autocontenido) y plan C manual. Verificación del webhook manual.
    const TWURPLE_AUTH_URL = "https://esm.sh/@twurple/auth@8.2.0?bundle&target=node";
    const { createHmac, createHash, randomBytes, timingSafeEqual } = await import("node:crypto");

    // login -> started_at del directo conocido. Persiste en vars, así sobrevive
    // a recargas/reinicios: "sigue el mismo directo" = silencio, "directo
    // nuevo" (o no visto antes) = aviso. Sin estado previo se avisa de lo que
    // haya en vivo (mejor un aviso de más que perderse un directo).
    const live = new Map();
    // Ficha del último directo visto por login (para la pestaña Directos).
    const info = new Map();
    try {
      const raw = await api.vars.get("liveState", "");
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object") {
        for (const [login, startedAt] of Object.entries(saved)) {
          if (typeof login === "string" && typeof startedAt === "string") live.set(login, startedAt);
        }
        if (live.size > 0) api.log.info(`twitch: estado recuperado (${live.size} en vivo)`);
      }
    } catch (e) {
      api.log.warn(`twitch: estado previo ilegible, se empieza de cero (${String(e).split("\n")[0]})`);
    }
    try {
      const rawInfo = await api.vars.get("streamInfo", "");
      const savedInfo = rawInfo ? JSON.parse(rawInfo) : null;
      if (savedInfo && typeof savedInfo === "object") {
        for (const [login, s] of Object.entries(savedInfo)) {
          if (typeof login === "string" && s && typeof s === "object") info.set(login, s);
        }
      }
    } catch {
      /* sin ficha previa: se rellena en el próximo poll */
    }
    let appToken = null;

    async function save() {
      try {
        await api.vars.set("liveState", JSON.stringify(Object.fromEntries(live)));
        await api.vars.set("streamInfo", JSON.stringify(Object.fromEntries(info)));
      } catch (e) {
        api.log.warn(`twitch: no se pudo guardar estado (${String(e).split("\n")[0]}`);
      }
    }

    const cfg = () => ({
      streamers: String(api.config.streamers ?? "")
        .split(/[\s,]+/)
        .map((s) => s.toLowerCase())
        .filter(Boolean),
      channelId: String(api.config.channelId ?? ""),
      minutes: Math.min(60, Math.max(2, Number(api.config.checkMinutes ?? 5) || 5)),
      template: String(api.config.liveMessage ?? "🔴 {streamer} en vivo: {title} {url}"),
      mentionRole: String(api.config.mentionRole ?? ""),
    });

    // Cliente twurple (local > esm.sh) o null si no hay credenciales.
    // El provider auto-refresca el app token; el ApiClient gestiona
    // usuarios y suscripciones EventSub. Sin twurple: Helix manual.
    let tw = null;
    async function twurple() {
      const id = String(api.config.twitchClientId ?? "");
      const secret = String(api.config.twitchClientSecret ?? "");
      if (!id || !secret) throw new Error("falta TWITCH_CLIENT_ID / SECRET (pestaña Ajustes)");
      const creds = `${id}\n${secret}`;
      if (tw && tw.creds === creds) return tw;
      let authMod;
      try {
        authMod = await api.lib.pkg("@twurple/auth");
      } catch (e) {
        api.log.warn(`twitch: @twurple/auth local no disponible, vía esm.sh (${String(e).split("\n")[0]})`);
        authMod = await api.lib.importUrl(TWURPLE_AUTH_URL);
      }
      let apiMod = null;
      try {
        apiMod = await api.lib.pkg("@twurple/api");
      } catch {
        apiMod = null; // sin ApiClient: token twurple + Helix manual
      }
      const provider = new authMod.AppTokenAuthProvider(id, secret);
      tw = {
        creds,
        provider,
        client: apiMod && apiMod.ApiClient ? new apiMod.ApiClient({ authProvider: provider }) : null,
      };
      return tw;
    }

    async function token() {
      const id = String(api.config.twitchClientId ?? "");
      const secret = String(api.config.twitchClientSecret ?? "");
      if (!id || !secret) throw new Error("falta TWITCH_CLIENT_ID / SECRET (pestaña Ajustes)");
      try {
        const t = await twurple();
        const tok = await t.provider.getAppAccessToken();
        if (tok && tok.accessToken) return { token: tok.accessToken, id };
        throw new Error("twurple: token vacío");
      } catch (e) {
        if (String(e && e.message ? e.message : e).startsWith("falta ")) throw e;
        api.log.warn(`twitch: twurple auth falló, plan B manual (${String(e).split("\n")[0]})`);
        tw = null;
      }
      if (appToken) return appToken;
      const res = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: id,
          client_secret: secret,
          grant_type: "client_credentials",
        }),
      });
      if (!res.ok) throw new Error(`twitch token: HTTP ${res.status}`);
      const data = await res.json();
      appToken = { token: data.access_token, id };
      return appToken;
    }

    function bustToken() {
      appToken = null;
      tw = null;
    }

    async function streams(auth, logins) {
      const q = logins.map((s) => `user_login=${encodeURIComponent(s)}`).join("&");
      let res = await fetch(`https://api.twitch.tv/helix/streams?${q}&first=100`, {
        headers: { "Client-Id": auth.id, Authorization: `Bearer ${auth.token}` },
      });
      if (res.status === 401) {
        // Token caducado: se pide uno nuevo y se reintenta una vez.
        bustToken();
        auth = await token();
        res = await fetch(`https://api.twitch.tv/helix/streams?${q}&first=100`, {
          headers: { "Client-Id": auth.id, Authorization: `Bearer ${auth.token}` },
        });
      }
      if (!res.ok) throw new Error(`twitch streams: HTTP ${res.status}`);
      return (await res.json()).data ?? [];
    }

    // --- EventSub webhook (avisos instantáneos, polling como respaldo) ---
    const web = () => ({
      enabled: api.config.useWebhook === true,
      base: String(api.config.publicBaseUrl ?? "").replace(/\/+$/, ""),
    });
    const eventsubCallback = () => `${web().base}/plugin-routes/twitch/eventsub`;

    async function webhookSecret() {
      let s = String((await api.vars.get("webhookSecret", "")) ?? "");
      if (!s) {
        s = randomBytes(32).toString("hex");
        await api.vars.set("webhookSecret", s);
        api.log.info("twitch: secreto de webhook generado (vars, oculto)");
      }
      return s;
    }

    function readEventsubState(saved) {
      try {
        const o = JSON.parse(saved || "{}");
        if (o && typeof o === "object") {
          return {
            secretHash: typeof o.secretHash === "string" ? o.secretHash : "",
            callback: typeof o.callback === "string" ? o.callback : "",
            subs: o.subs && typeof o.subs === "object" ? o.subs : {},
          };
        }
      } catch { /* estado roto: se reconstruye */ }
      return { secretHash: "", callback: "", subs: {} };
    }

    // Capa Helix para EventSub: twurple ApiClient si está disponible,
    // si no Helix manual con la misma forma ({userIds, listSubs, createSub, deleteSub}).
    async function helixApi() {
      try {
        const t = await twurple();
        if (t.client) {
          const c = t.client;
          return {
            via: "twurple",
            userIds: async (logins) => {
              const users = await c.users.getUsersByNames(logins);
              return new Map(users.map((u) => [String(u.name).toLowerCase(), String(u.id)]));
            },
            listSubs: async () => {
              const page = await c.eventSub.getSubscriptions();
              return (page.data ?? []).map((s) => ({
                id: s.id,
                type: s.type,
                transport: { callback: s.transport && s.transport.callback },
                condition: { broadcaster_user_id: s.condition && s.condition.broadcaster_user_id },
              }));
            },
            createSub: async (type, _version, broadcasterId, callback, secret) => {
              const sub =
                type === "stream.online"
                  ? await c.eventSub.subscribeToStreamOnlineEvents(broadcasterId, {
                      method: "webhook",
                      callback,
                      secret,
                    })
                  : await c.eventSub.subscribeToStreamOfflineEvents(broadcasterId, {
                      method: "webhook",
                      callback,
                      secret,
                    });
              return { id: sub.id };
            },
            deleteSub: async (id) => {
              try {
                await c.eventSub.deleteSubscription(id);
              } catch (e) {
                if (!/404|not found/i.test(String(e))) throw e;
              }
            },
          };
        }
      } catch (e) {
        if (String(e && e.message ? e.message : e).startsWith("falta ")) throw e;
        api.log.warn(`twitch: twurple api no disponible, Helix manual (${String(e).split("\n")[0]})`);
      }
      const auth = await token();
      const send = (tok, method, path, body) =>
        fetch(`https://api.twitch.tv/helix${path}`, {
          method,
          headers: { "Client-Id": auth.id, Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const call = async (method, path, body) => {
        let res = await send(auth.token, method, path, body);
        if (res.status === 401) {
          bustToken();
          Object.assign(auth, await token());
          res = await send(auth.token, method, path, body);
        }
        return res;
      };
      return {
        via: "manual",
        userIds: async (logins) => {
          const out = new Map();
          for (let i = 0; i < logins.length; i += 100) {
            const q = logins
              .slice(i, i + 100)
              .map((s) => `login=${encodeURIComponent(s)}`)
              .join("&");
            const res = await call("GET", `/users?${q}`);
            if (!res.ok) throw new Error(`twitch users: HTTP ${res.status}`);
            const data = (await res.json()).data ?? [];
            for (const u of data) out.set(String(u.login).toLowerCase(), String(u.id));
          }
          return out;
        },
        listSubs: async () => {
          const res = await call("GET", "/eventsub/subscriptions");
          if (!res.ok) throw new Error(`twitch subs: HTTP ${res.status}`);
          return (await res.json()).data ?? [];
        },
        createSub: async (type, version, broadcasterId, callback, secret) => {
          const res = await call("POST", "/eventsub/subscriptions", {
            type,
            version,
            condition: { broadcaster_user_id: broadcasterId },
            transport: { method: "webhook", callback, secret },
          });
          if (res.status !== 202) {
            const txt = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
          }
          const created = ((await res.json()).data || [])[0];
          if (!created) throw new Error("sin data en 202");
          return { id: created.id };
        },
        deleteSub: async (id) => {
          const res = await call("DELETE", `/eventsub/subscriptions?id=${encodeURIComponent(id)}`);
          if (!res.ok && res.status !== 404) throw new Error(`unsubscribe: HTTP ${res.status}`);
        },
      };
    }

    async function reconcileEventSub() {
      const w = web();
      if (!w.enabled) return;
      if (!w.base.startsWith("https://")) {
        api.log.warn("twitch: useWebhook activo pero publicBaseUrl no es https (se sigue con polling)");
        return;
      }
      const callback = eventsubCallback();
      let secret;
      try {
        secret = await webhookSecret();
      } catch (e) {
        api.log.error(`twitch eventsub: sin secreto (${String(e).split("\n")[0]})`);
        return;
      }
      let hx;
      try {
        hx = await helixApi();
      } catch (e) {
        api.log.error(`twitch eventsub: sin API (${String(e).split("\n")[0]}), polling sigue`);
        return;
      }
      api.log.info(`twitch eventsub vía ${hx.via}`);
      const streamers = cfg().streamers;
      let ids;
      try {
        ids = await hx.userIds(streamers);
      } catch (e) {
        api.log.error(`twitch eventsub: sin IDs (${String(e).split("\n")[0]}), polling sigue`);
        return;
      }
      for (const s of streamers) {
        if (!ids.has(s)) api.log.warn(`twitch: sin ID para "${s}" (¿login mal escrito?)`);
      }
      const secretHash = createHash("sha256").update(secret).digest("hex");
      const prev = readEventsubState(String((await api.vars.get("eventsubState", "")) ?? ""));
      const rotated = prev.secretHash !== "" && prev.secretHash !== secretHash;
      const moved = prev.callback !== "" && prev.callback !== callback;
      let existing = [];
      try {
        existing = (await hx.listSubs()).filter(
          (s) => s && s.transport && s.transport.callback === callback,
        );
      } catch (e) {
        api.log.error(`twitch eventsub: no se pudo listar (${String(e).split("\n")[0]}), polling sigue`);
        return;
      }
      const liveIds = new Map(existing.map((s) => [s.id, s]));
      const want = [];
      for (const [login, bid] of ids) {
        want.push({ type: "stream.online", version: "2", login, bid });
        want.push({ type: "stream.offline", version: "1", login, bid });
      }
      const wantIds = new Set([...ids.values()]);
      const kept = new Set();
      for (const s of existing) {
        const bid = String((s.condition && s.condition.broadcaster_user_id) || "");
        if (rotated || moved || !wantIds.has(bid)) {
          try {
            await hx.deleteSub(s.id);
            api.log.info(`twitch: sub ${s.type} eliminada (sobrante)`);
          } catch (e) {
            api.log.warn(`twitch: no se pudo borrar sub ${s.id} (${String(e).split("\n")[0]})`);
          }
          liveIds.delete(s.id);
        }
      }
      const next = {};
      for (const item of want) {
        const prevSub = prev.subs[item.login] && prev.subs[item.login][item.type === "stream.online" ? "online" : "offline"];
        if (!rotated && !moved && prevSub && liveIds.has(prevSub)) {
          kept.add(prevSub);
          next[item.login] = next[item.login] || {};
          next[item.login].broadcasterId = item.bid;
          next[item.login][item.type === "stream.online" ? "online" : "offline"] = prevSub;
          continue;
        }
        // El estado local puede haberse perdido (p. ej. restauración de DB o
        // recreación de vars). Reutiliza la sub activa de Twitch para evitar
        // crear un duplicado y recibir HTTP 409.
        const existingSub = !rotated && !moved
          ? existing.find((s) =>
              s.type === item.type &&
              String((s.condition && s.condition.broadcaster_user_id) || "") === item.bid
            )
          : null;
        if (existingSub) {
          kept.add(existingSub.id);
          next[item.login] = next[item.login] || { broadcasterId: item.bid };
          next[item.login].broadcasterId = item.bid;
          next[item.login][item.type === "stream.online" ? "online" : "offline"] = existingSub.id;
          api.log.info(`twitch: sub ${item.type} para ${item.login} ya existía; reutilizada`);
          continue;
        }
        try {
          const created = await hx.createSub(item.type, item.version, item.bid, callback, secret);
          kept.add(created.id);
          next[item.login] = next[item.login] || { broadcasterId: item.bid };
          next[item.login].broadcasterId = item.bid;
          next[item.login][item.type === "stream.online" ? "online" : "offline"] = created.id;
          api.log.info(`twitch: sub ${item.type} para ${item.login} OK`);
        } catch (e) {
          api.log.error(`twitch: no se pudo suscribir ${item.type} ${item.login} (${String(e).split("\n")[0]})`);
        }
      }
      // Limpieza final: lo que queda vivo y no se quiere, fuera.
      for (const [id] of liveIds) {
        if (!kept.has(id)) {
          try {
            await hx.deleteSub(id);
          } catch { /* best-effort */ }
        }
      }
      try {
        await api.vars.set("eventsubState", JSON.stringify({ secretHash, callback, subs: next }));
      } catch (e) {
        api.log.warn(`twitch: no se pudo guardar eventsubState (${String(e).split("\n")[0]})`);
      }
    }

    async function deleteTrackedSubs() {
      try {
        const prev = readEventsubState(String((await api.vars.get("eventsubState", "")) ?? ""));
        const ids = new Set();
        for (const entry of Object.values(prev.subs)) {
          if (entry && typeof entry === "object") {
            if (entry.online) ids.add(entry.online);
            if (entry.offline) ids.add(entry.offline);
          }
        }
        if (ids.size === 0) return;
        const hx = await helixApi().catch(() => null);
        if (!hx) return;
        for (const id of ids) {
          try {
            await hx.deleteSub(id);
          } catch { /* best-effort */ }
        }
        api.log.info(`twitch: ${ids.size} subs EventSub eliminadas (apagado/recarga)`);
      } catch { /* best-effort */ }
    }

    function verifySignature(secret, msgId, msgTs, raw, sig) {
      if (!msgId || !msgTs || !sig) return false;
      // Updates encadenados (no `msgId + msgTs + raw`): la concatenación
      // string + Buffer reinterpretaría bytes no-UTF8 y rompería la firma.
      const expected = `sha256=${createHmac("sha256", secret).update(msgId).update(msgTs).update(raw).digest("hex")}`;
      try {
        return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      } catch {
        return false;
      }
    }

    // Ruta pública del webhook (raw: bytes intactos para la firma HMAC).
    if (web().enabled && web().base.startsWith("https://")) {
      api.http.post(
        "eventsub",
        async (ctx) => {
          const secret = String((await api.vars.get("webhookSecret", "")) ?? "");
          if (!secret) return { status: 500, body: "sin secreto" };
          const h = ctx.headers || {};
          const ok = verifySignature(
            secret,
            h["twitch-eventsub-message-id"],
            h["twitch-eventsub-message-timestamp"],
            Buffer.from(ctx.rawBody),
            h["twitch-eventsub-message-signature"],
          );
          if (!ok) {
            api.log.warn("twitch: firma EventSub inválida (403)");
            return { status: 403, body: "bad signature" };
          }
          let body;
          try {
            body = JSON.parse(ctx.text());
          } catch {
            return { status: 400, body: "json inválido" };
          }
          const msgType = h["twitch-eventsub-message-type"];
          if (msgType === "webhook_callback_verification") {
            api.log.info("twitch: webhook verificado por Twitch ✓");
            return String(body.challenge || "");
          }
          if (msgType === "revocation") {
            api.log.warn(`twitch: suscripción revocada (${body.subscription && body.subscription.type})`);
            return;
          }
          if (msgType === "notification") {
            const ev = body.event || {};
            const login = String(ev.broadcaster_user_login || "").toLowerCase();
            const subType = body.subscription && body.subscription.type;
            if (subType === "stream.online" && login) {
              const startedAt = ev.started_at || "";
              info.set(login, {
                title: ev.title || "",
                game: ev.category_name || "",
                viewers: 0,
                startedAt,
              });
              if (live.get(login) !== startedAt) {
                live.set(login, startedAt);
                await save();
                const payload = {
                  user_name: ev.broadcaster_user_name || login,
                  title: ev.title || "",
                  game_name: ev.category_name || "",
                  viewer_count: 0,
                  started_at: startedAt,
                };
                void api.emit("stream-started", streamPayload(login, payload, "eventsub"));
                try {
                  await notify(login, payload, "eventsub");
                } catch (e) {
                  api.log.error(`twitch: aviso ${login}: ${String(e).split("\n")[0]}`);
                }
              }
            } else if (subType === "stream.offline" && login) {
              if (live.has(login)) {
                live.delete(login);
                await save();
                api.log.info(`twitch: ${login} terminó el directo (vía eventsub)`);
                void api.emit("stream-ended", { login, via: "eventsub" });
              }
            }
            return;
          }
          return;
        },
        { raw: true },
      );
      api.onCleanup(() => deleteTrackedSubs());
      // Reconcilia en segundo plano (no bloquea el setup de 10s).
      void reconcileEventSub().catch((e) => api.log.error(`twitch eventsub: ${String(e).split("\n")[0]}`));
    }

    // Payload del bus (`twitch:stream-started`): misma forma venga de
    // polling (objeto Helix) o del webhook (mapeo manual con started_at).
    // `via` es "poll" o "eventsub".
    function streamPayload(login, s, via) {
      return {
        login,
        name: s.user_name || login,
        title: s.title || "",
        game: s.game_name || "",
        viewers: s.viewer_count ?? 0,
        url: `https://twitch.tv/${login}`,
        startedAt: s.started_at || "",
        via,
      };
    }

    function render(login, s, template, mentionRole) {
      const text = template
        .replaceAll("{streamer}", s.user_name || login)
        .replaceAll("{title}", s.title || "")
        .replaceAll("{game}", s.game_name || "")
        .replaceAll("{viewers}", String(s.viewer_count ?? 0))
        .replaceAll("{url}", `https://twitch.tv/${login}`);
      // Los pings solo notifican en el contenido del mensaje.
      return (mentionRole ? `<@&${mentionRole}> ` : "") + text;
    }

    async function notify(login, s, via) {
      const c = cfg();
      if (!c.channelId) {
        api.log.warn("twitch: sin channelId, no aviso");
        return;
      }
      let channel = null;
      try {
        channel = await api.client.channels.fetch(c.channelId);
      } catch (e) {
        api.log.error(`twitch: canal ${c.channelId}: ${String(e).split("\n")[0]}`);
        return;
      }
      if (!channel) {
        api.log.error(`twitch: canal ${c.channelId} no encontrado`);
        return;
      }
      await api.sendMessage(channel, render(login, s, c.template, c.mentionRole));
      api.log.info(`twitch: ${login} en vivo, avisado (vía ${via === "eventsub" ? "eventsub" : "poll"})`);
      try {
        await api.vars.incr("notifiedTotal", 1);
      } catch (e) {
        api.log.warn(`twitch: no se pudo contar el aviso (${String(e).split("\n")[0]}`);
      }
    }

    async function poll() {
      const c = cfg();
      if (c.streamers.length === 0) {
        // Sin vigilados no hay nada que podar en la API: limpia aquí para
        // no dejar fantasmas (esto SÍ se persistía y sobrevivía reinicios).
        if (live.size > 0 || info.size > 0) {
          live.clear();
          info.clear();
          await save();
        }
        return;
      }
      let auth;
      try {
        auth = await token();
      } catch (e) {
        api.log.error(`twitch: ${String(e).split("\n")[0]}`);
        return;
      }
      let list;
      try {
        list = await streams(auth, c.streamers);
      } catch (e) {
        api.log.error(`twitch: ${String(e).split("\n")[0]}`);
        return;
      }
      const now = new Map(list.map((s) => [String(s.user_login).toLowerCase(), s]));
      for (const [login, s] of now) {
        info.set(login, {
          title: s.title ?? "",
          game: s.game_name ?? "",
          viewers: s.viewer_count ?? 0,
          startedAt: s.started_at ?? "",
        });
      }
      let changed = false;
      for (const [login, s] of now) {
        const startedAt = s.started_at ?? "";
        if (live.get(login) !== startedAt) {
          live.set(login, startedAt);
          changed = true;
          void api.emit("stream-started", streamPayload(login, s, "poll"));
          try {
            await notify(login, s, "poll");
          } catch (e) {
            api.log.error(`twitch: aviso ${login}: ${String(e).split("\n")[0]}`);
          }
        }
      }
      for (const login of [...live.keys()]) {
        if (!now.has(login)) {
          live.delete(login);
          changed = true;
          void api.emit("stream-ended", { login, via: "poll" });
        }
      }
      if (changed) await save();
    }

    const c = cfg();
    api.jobs.every("poll", `${c.minutes}m`, () => poll());
    api.jobs.in("first-check", 5000, () => poll());

    // Pestaña "Directos" en el panel: stats + tabla + comprobación manual.
    api.ui.registerTab({ id: "directos", label: "Directos", icon: "video", description: "Quién está en vivo ahora mismo" });
    api.ui.data("vigilados", () => cfg().streamers.length);
    // Solo cuentan los que SIGUEN vigilados: si quitas uno de la config,
    // desaparece del panel al instante (sin esperar al próximo poll).
    // Se filtra en lectura, sin tocar `live`, para no provocar re-avisos.
    const vigiladosAhora = () => new Set(cfg().streamers);
    api.ui.data("en-vivo", () => {
      const watched = vigiladosAhora();
      let n = 0;
      for (const login of live.keys()) if (watched.has(login)) n++;
      return n;
    });
    api.ui.data("avisos", async () => await api.vars.get("notifiedTotal", 0));
    api.ui.widget("directos", { kind: "stat", id: "w-vivo", title: "En vivo ahora", data: "en-vivo", icon: "video" });
    api.ui.widget("directos", { kind: "stat", id: "w-vigilados", title: "Vigilados", data: "vigilados", icon: "bell" });
    api.ui.widget("directos", { kind: "stat", id: "w-avisos", title: "Avisos enviados", data: "avisos", icon: "zap" });
    api.ui.data("tabla-vivo", () => {
      const watched = vigiladosAhora();
      const rows = [];
      for (const login of live.keys()) {
        if (!watched.has(login)) continue;
        const s = info.get(login) ?? {};
        rows.push({
          login,
          title: s.title || "—",
          game: s.game || "—",
          viewers: s.viewers ?? 0,
        });
      }
      return rows;
    });
    api.ui.widget("directos", {
      kind: "table",
      id: "w-tabla",
      title: "En directo ahora",
      data: "tabla-vivo",
      width: "full",
      columns: [
        { key: "login", label: "Streamer", mono: true },
        { key: "title", label: "Título" },
        { key: "game", label: "Juego" },
        { key: "viewers", label: "Viewers" },
      ],
      empty: "Nadie en directo. Silencio… 🤫",
    });
    api.ui.action({ id: "revisar", label: "Comprobar ahora" }, async () => {
      await poll();
      return "chequeo hecho ✓";
    });
    api.ui.widget("directos", { kind: "actions", id: "w-acciones", items: ["revisar"] });

    api.log.info("twitch listo (primer chequeo en 5s)");
  },
});
