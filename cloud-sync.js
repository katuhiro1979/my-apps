// 自作アプリ共通のクラウド同期モジュール(Supabase)。単一HTMLのアプリから使う。
// 使い方(アプリ側):
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="cloud-sync.js"></script>
//   const sync = CloudSync.init({
//     appName: "貸出台帳",              // クラウド上でのアプリ名
//     key: "data-v1",                   // 保存キー
//     getData: () => ({ ... }),         // 同期したいデータ(JSON化できるオブジェクト)を返す
//     applyData: (obj) => { ... },      // クラウドのデータを画面と端末内の保存先へ反映する
//     hasData: () => true/false,        // 端末に記録があるか(空の端末でクラウドを上書きしないため)
//   });
//   // 端末内へ保存した直後に sync.notifyChanged() を呼ぶ
// supabase-js を読み込めない場合(オフライン等)は何もせず、アプリは従来どおり端末内だけで動く。
(function () {
  const CFG = {
    url: "https://kcadsiwjxlmhzremgzet.supabase.co",
    // 公開しても問題ない anon キーのみ。service_role キーは絶対に入れないこと。
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjYWRzaXdqeGxtaHpyZW1nemV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4ODgzNzAsImV4cCI6MjEwNTQ2NDM3MH0.ZOm5zNFazsLKFl8N-oLhBeUxZcYscPNdOpYPOwq8d9M",
  };
  const TABLE = "app_kv";
  const DELAY_MS = 5000; // 編集が止まってからクラウドへ送るまでの待ち時間

  // 文字列の簡易ハッシュ(同期済みかどうかの比較用。暗号用途ではない)
  const hash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return s.length + ":" + h;
  };
  const hm = () => new Date().toTimeString().slice(0, 5);
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 容量不足などは無視 */ } };

  function init(opts) {
    const noop = { notifyChanged() {} };
    if (!window.supabase) return noop;
    let sb;
    try { sb = window.supabase.createClient(CFG.url, CFG.key); } catch (e) { return noop; }

    const { appName, key, getData, applyData, hasData } = opts;
    const META_KEY = "cloudsync-meta::" + appName + "::" + key;
    const BACKUP_KEY = "cloudsync-backup::" + appName + "::" + key;
    let meta = { hash: null, at: null };
    try { meta = Object.assign(meta, JSON.parse(lsGet(META_KEY) || "{}")); } catch (e) { /* 壊れていたら未同期扱い */ }

    let user = null, status = "", conflict = null, msg = "", open = false;
    let busy = false, again = false, timer = null;

    const saveMeta = (h, at) => { meta = { hash: h, at }; lsSet(META_KEY, JSON.stringify(meta)); };
    // 上書きされる側のデータを1世代だけ端末内に退避する
    const backup = (reason, data) => lsSet(BACKUP_KEY, JSON.stringify({ at: new Date().toLocaleString("ja-JP"), reason, data }));

    // ---- 通信 ----
    const pull = () => sb.from(TABLE).select("value, updated_at").eq("app_name", appName).eq("key", key).maybeSingle();
    async function push(value, expectedAt) {
      if (expectedAt) {
        const { data, error } = await sb.from(TABLE).update({ value })
          .eq("app_name", appName).eq("key", key).eq("updated_at", expectedAt).select("updated_at");
        if (error) return { error };
        if (!data || !data.length) return { conflict: true }; // 他の端末が先に更新していた
        return { updatedAt: data[0].updated_at };
      }
      const { data, error } = await sb.from(TABLE).insert({ app_name: appName, key, value }).select("updated_at");
      if (error) return error.code === "23505" ? { conflict: true } : { error };
      return { updatedAt: data[0].updated_at };
    }

    // ---- 同期 ----
    async function applyRemote(remote, localJson) {
      const parsed = JSON.parse(remote.value);
      if (hasData()) backup("同期前の端末データ", localJson);
      applyData(parsed);
      // 反映後の実際の状態を「同期済み」として記録する(往復で更新し合わないため)
      saveMeta(hash(JSON.stringify(getData())), remote.updated_at);
    }

    async function sync(attempt) {
      attempt = attempt || 0;
      if (!user || conflict) return;
      if (busy) { again = true; return; }
      busy = true;
      let retry = false;
      try {
        setStatus("同期中…");
        const { data: remote, error } = await pull();
        if (error) throw error;
        const localJson = JSON.stringify(getData());
        const lh = hash(localJson);
        const has = hasData();
        const pushLocal = async (expectedAt) => {
          const r = await push(localJson, expectedAt);
          if (r.error) throw r.error;
          if (r.conflict) { retry = true; return; }
          saveMeta(lh, r.updatedAt);
        };
        if (!remote) {
          if (has) await pushLocal(null); // クラウドが空のときだけ初回アップロード
        } else if (hash(remote.value) === lh) {
          saveMeta(lh, remote.updated_at);
        } else if (!has) {
          await applyRemote(remote, localJson); // この端末が空なら、クラウドを取り込む
        } else {
          const localChanged = lh !== meta.hash;
          const remoteChanged = remote.updated_at !== meta.at;
          if (!localChanged && remoteChanged) await applyRemote(remote, localJson);
          else if (localChanged && !remoteChanged) await pushLocal(remote.updated_at);
          else if (localChanged && remoteChanged) { conflict = remote; open = true; } // 両方変更: 上書きせず選んでもらう
        }
        if (!retry) setStatus("同期済み " + hm());
      } catch (e) {
        console.error("クラウド同期に失敗しました", e);
        setStatus("同期できません(オフライン?端末内には保存されています)");
      } finally {
        busy = false;
      }
      render();
      if ((retry && attempt < 2) || again) {
        again = false;
        await sync(retry ? attempt + 1 : 0);
      }
    }

    async function resolveWithCloud() {
      const remote = conflict;
      conflict = null;
      try { await applyRemote(remote, JSON.stringify(getData())); setStatus("クラウドの内容を反映しました " + hm()); }
      catch (e) { setStatus("クラウドのデータを読み込めませんでした"); }
      render();
    }
    async function resolveWithLocal() {
      const remote = conflict;
      conflict = null;
      backup("同期前のクラウドデータ", remote.value);
      const json = JSON.stringify(getData());
      const r = await push(json, remote.updated_at);
      if (r.updatedAt) { saveMeta(hash(json), r.updatedAt); setStatus("この端末の内容を送信しました " + hm()); }
      else sync();
      render();
    }

    // ---- 画面(右下の ☁ ボタンとパネル) ----
    const css = document.createElement("style");
    css.textContent =
      "#cs-btn{position:fixed;right:12px;bottom:12px;z-index:99998;width:44px;height:44px;border-radius:50%;border:1px solid #888;background:#fff;color:#333;font-size:20px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)}" +
      "#cs-btn.on{background:#2c4d66;color:#fff;border-color:#2c4d66}" +
      "#cs-panel{position:fixed;right:12px;bottom:64px;z-index:99999;width:min(320px,calc(100vw - 24px));box-sizing:border-box;padding:12px;border-radius:10px;background:#fff;color:#222;border:1px solid #bbb;box-shadow:0 4px 16px rgba(0,0,0,.3);font:14px/1.5 sans-serif;display:none}" +
      "#cs-panel.open{display:block}#cs-panel *{box-sizing:border-box;font-family:inherit}" +
      "#cs-panel input{display:block;width:100%;margin:6px 0;padding:8px;font-size:16px}" +
      "#cs-panel button{margin:4px 4px 0 0;padding:8px 10px;font-size:14px;cursor:pointer}" +
      "#cs-panel .cs-msg{color:#c00;font-size:13px}#cs-panel .cs-st{color:#555;font-size:13px}";
    document.head.appendChild(css);
    const btn = document.createElement("button");
    btn.id = "cs-btn";
    btn.type = "button";
    btn.textContent = "☁";
    const panel = document.createElement("div");
    panel.id = "cs-panel";
    document.body.append(btn, panel);
    btn.onclick = () => { open = !open; render(); };

    const el = (tag, text, props) => Object.assign(document.createElement(tag), text != null ? { textContent: text } : {}, props || {});
    function button(label, fn) { const b = el("button", label, { type: "button" }); b.onclick = fn; return b; }
    function setStatus(s) { status = s; render(); }

    function render() {
      btn.classList.toggle("on", !!user);
      btn.title = user ? "クラウド同期: " + (status || "ログイン中") : "クラウド同期(ログインすると端末間でデータが同期されます)";
      panel.classList.toggle("open", open);
      if (!open) return;
      panel.replaceChildren();
      panel.append(el("b", "☁ クラウド同期"));
      if (conflict) {
        panel.append(el("p", "この端末とクラウドの両方でデータが変更されています。どちらを使いますか?(選ばなかった方は端末内に1世代だけ退避されます)"));
        panel.append(button("クラウドの内容を使う", resolveWithCloud), button("この端末の内容を使う", resolveWithLocal));
        return;
      }
      if (user) {
        panel.append(el("p", "ログイン中: " + user));
        panel.append(el("p", status, { className: "cs-st" }));
        panel.append(button("今すぐ同期", () => sync()), button("ログアウト", () => { sb.auth.signOut(); status = ""; }));
      } else {
        panel.append(el("p", "ログインすると、PCとスマホでデータが同期されます(データは端末内にも保存されます)。"));
        const em = el("input", null, { type: "email", placeholder: "メールアドレス" });
        const pw = el("input", null, { type: "password", placeholder: "パスワード(6文字以上)" });
        const m = el("p", msg, { className: "cs-msg" });
        const go = async (signUp) => {
          msg = "";
          const r = signUp ? await sb.auth.signUp({ email: em.value, password: pw.value }) : await sb.auth.signInWithPassword({ email: em.value, password: pw.value });
          msg = r.error ? r.error.message : (signUp ? "登録しました。確認メールが届いた場合はリンクを開いてからログインしてください。" : "");
          if (r.error || signUp) render();
        };
        panel.append(em, pw, button("ログイン", () => go(false)), button("新規登録", () => go(true)), m);
      }
      const bk = lsGet(BACKUP_KEY);
      if (bk) {
        panel.append(el("p", null), button("退避データを保存(JSON)", () => {
          const b = JSON.parse(bk);
          const a = el("a", null, { href: URL.createObjectURL(new Blob([b.data], { type: "application/json" })), download: appName + "_退避_" + b.at.replace(/[\/: ]/g, "") + ".json" });
          document.body.append(a); a.click(); a.remove();
        }));
      }
    }

    // ---- 起動 ----
    sb.auth.getSession().then(({ data }) => { user = data && data.session ? data.session.user.email : null; render(); sync(); });
    sb.auth.onAuthStateChange((_e, session) => {
      const next = session ? session.user.email : null;
      if (next === user) return;
      user = next;
      render();
      sync();
    });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); });
    window.addEventListener("online", () => sync());
    render();

    return {
      // 端末内へ保存した直後に呼ぶ。編集が落ち着いてからクラウドへ送る。
      notifyChanged() {
        if (!user) return;
        clearTimeout(timer);
        timer = setTimeout(() => sync(), DELAY_MS);
      },
    };
  }

  window.CloudSync = { init };
})();
