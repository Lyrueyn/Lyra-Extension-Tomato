(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const backend = (params.get("backend") || "").replace(/\/$/, "");
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;

  const state = {
    readers: [],
    allowed: new Set(),
    book: null,
    jobTimer: 0,
    hostSeq: 0,
    hostPending: new Map(),
    importing: false,
  };

  const FORMAT_LABEL = { txt: "TXT", epub: "EPUB", pdf: "PDF" };
  const EXT_TO_FORMAT = { ".txt": "txt", ".epub": "epub", ".pdf": "pdf" };

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function postHost(type, extra = {}) {
    return new Promise((resolve) => {
      if (!host) { resolve(null); return; }
      const requestId = "tomato-" + (++state.hostSeq) + "-" + Date.now();
      state.hostPending.set(requestId, resolve);
      host.postMessage({ type, requestId, ...extra });
      setTimeout(() => {
        if (state.hostPending.has(requestId)) {
          state.hostPending.delete(requestId);
          resolve(null);
        }
      }, 6000);
    });
  }

  if (host) {
    host.addEventListener("message", (event) => {
      const data = event.data || {};
      if (!data || !data.type) return;
      if (data.type === "host.capabilities.result") {
        const result = state.hostPending.get(data.requestId);
        if (result) { state.hostPending.delete(data.requestId); result(data); }
      } else if (data.type === "host.importBook.result") {
        const result = state.hostPending.get(data.requestId);
        if (result) { state.hostPending.delete(data.requestId); result(data); }
      }
    });
  }

  async function api(path, body) {
    if (!backend) throw new Error("缺少 backend 参数，请从璃鸢镜扩展中心打开");
    const res = await fetch(backend + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { throw new Error("后端返回非 JSON：" + text.slice(0, 200)); }
    if (!res.ok) throw new Error((data && (data.detail || data.error)) || ("HTTP " + res.status));
    return data;
  }

  function refreshFormatOptions() {
    const installed = new Set();
    for (const r of state.readers) {
      for (const t of (r.fileTypes || [])) {
        const f = EXT_TO_FORMAT[String(t).toLowerCase()];
        if (f) installed.add(f);
      }
    }
    state.allowed = installed;
    const boxes = { txt: $("fmtTxt"), epub: $("fmtEpub"), pdf: $("fmtPdf") };
    for (const [fmt, box] of Object.entries(boxes)) {
      const ok = installed.has(fmt);
      box.disabled = !ok;
      box.checked = ok;
      box.parentElement.style.opacity = ok ? "1" : ".4";
    }
    const missing = ["txt", "epub", "pdf"].filter((f) => !installed.has(f)).map((f) => FORMAT_LABEL[f]);
    $("formatHint").textContent = installed.size === 0
      ? "没有已安装的阅读器扩展，无法下载。"
      : (missing.length ? "未安装的阅读器对应格式已禁用：" + missing.join(" / ") : "三种格式的阅读器都已安装，可任选格式。");
    $("downloadBtn").disabled = installed.size === 0;
  }

  async function loadPrerequisites() {
    if (!host) {
      $("prereq").hidden = false;
      $("prereq").textContent = "当前不是扩展宿主环境，无法检测阅读器。请从璃鸢镜扩展中心打开。";
      return;
    }
    const data = await postHost("host.capabilities");
    state.readers = (data && data.extensions) || [];
    refreshFormatOptions();
    $("prereq").hidden = state.allowed.size > 0;
  }

  function setHint(text, isError) {
    const el = $("searchHint");
    el.textContent = text || "";
    el.style.color = isError ? "#ff9aa8" : "var(--sub)";
  }

  async function search() {
    const keyword = $("searchInput").value.trim();
    if (!keyword) { setHint("请输入书名或作者", true); return; }
    $("searchBtn").disabled = true;
    setHint("正在搜索…");
    $("results").innerHTML = "";
    try {
      const data = await api("/api/tomato/search", { keyword });
      if (!data || !data.ok) throw new Error((data && data.error) || "搜索失败");
      const books = data.books || [];
      setHint(books.length ? "共 " + books.length + " 个结果，点击书籍继续" : "没有找到结果");
      $("results").innerHTML = books.map((b, i) => `
        <button class="book" data-index="${i}" type="button">
          <div class="title">${escapeHtml(b.book_name || b.book_id)}</div>
          <div class="meta">${escapeHtml(b.author || "未知作者")}</div>
          <div class="abstract">${escapeHtml((b.abstract || "").slice(0, 90))}</div>
        </button>`).join("");
      for (const el of $("results").querySelectorAll(".book")) {
        el.addEventListener("click", () => openBook(books[Number(el.dataset.index)]));
      }
    } catch (e) { setHint(String(e.message || e), true); }
    finally { $("searchBtn").disabled = false; }
  }

  async function openBook(book) {
    state.book = book;
    $("detail").hidden = false;
    $("doneCard").hidden = true;
    $("bookTitle").textContent = book.book_name || book.book_id;
    $("bookMeta").textContent = "作者：" + (book.author || "未知") + " · 获取目录中…";
    $("bookAbstract").textContent = book.abstract || "";
    $("startChapter").value = "1";
    $("endChapter").value = "1";
    $("progressCard").hidden = true;
    try {
      const data = await api("/api/tomato/info", { book_id: book.book_id });
      if (!data || !data.ok) throw new Error((data && data.error) || "获取目录失败");
      const info = data.book || {};
      state.book = { ...book, ...info };
      const total = (info.chapters || []).length;
      $("bookMeta").textContent = "作者：" + (info.author || book.author || "未知") + " · 共 " + total + " 章";
      $("bookAbstract").textContent = info.abstract || book.abstract || "";
      $("startChapter").max = String(Math.max(1, total));
      $("endChapter").max = String(Math.max(1, total));
      $("endChapter").value = String(Math.max(1, total));
    } catch (e) { $("bookMeta").textContent = "目录获取失败：" + (e.message || e); }
  }

  function selectedFormats() {
    const out = [];
    if ($("fmtTxt").checked && state.allowed.has("txt")) out.push("txt");
    if ($("fmtEpub").checked && state.allowed.has("epub")) out.push("epub");
    if ($("fmtPdf").checked && state.allowed.has("pdf")) out.push("pdf");
    return out;
  }

  async function startDownload() {
    if (!state.book) return;
    const formats = selectedFormats();
    if (formats.length === 0) { $("formatHint").textContent = "至少选择一个已安装阅读器对应的格式。"; return; }
    const start = Math.max(1, Number($("startChapter").value) || 1);
    const end = Math.max(start, Number($("endChapter").value) || start);
    $("downloadBtn").disabled = true;
    $("cancelBtn").disabled = false;
    $("progressCard").hidden = false;
    $("doneCard").hidden = true;
    $("progressBar").style.width = "0%";
    $("percentText").textContent = "0%";
    $("phaseText").textContent = "准备";
    $("progressInfo").textContent = "";
    try {
      const data = await api("/api/tomato/download", {
        book_id: state.book.book_id,
        start: Math.min(start, end),
        end: Math.max(start, end),
        formats,
      });
      if (!data || !data.ok) throw new Error((data && data.error) || "无法开始下载");
      pollJob();
    } catch (e) {
      $("downloadBtn").disabled = false;
      $("progressCard").hidden = true;
      $("formatHint").textContent = "下载失败：" + (e.message || e);
    }
  }

  async function loadLibrary() {
    try {
      const data = await api("/api/tomato/library");
      const books = (data && data.books) || [];
      const box = $("libraryList");
      if (!books.length) {
        box.innerHTML = '<div class="hint">还没有下载过的书。搜索并下载后会出现在这里。</div>';
        return;
      }
      box.innerHTML = books.map((b, i) => `
        <div class="book" style="cursor:default">
          <div class="title">${escapeHtml(b.book_name || b.book_id)}</div>
          <div class="meta">${escapeHtml(b.author || "未知作者")} · 已存 ${b.chapters || 0} 章</div>
          <div class="meta">格式：${Object.keys(b.formats || {}).map((f) => FORMAT_LABEL[f] || f).join(" / ") || "无"}</div>
          <div class="actions" style="margin-top:8px">
            <button class="primary update-book" data-index="${i}" type="button">检查更新</button>
          </div>
        </div>`).join("");
      for (const el of box.querySelectorAll(".update-book")) {
        el.addEventListener("click", () => updateBook(books[Number(el.dataset.index)]));
      }
    } catch (e) {
      $("libraryList").innerHTML = '<div class="hint">读取已下载书籍失败：' + escapeHtml(e.message || e) + '</div>';
    }
  }

  async function updateBook(local) {
    try {
      $("doneCard").hidden = true;
      const data = await api("/api/tomato/info", { book_id: local.book_id });
      if (!data || !data.ok) throw new Error((data && data.error) || "获取目录失败");
      const info = data.book || {};
      const total = (info.chapters || []).length;
      if (total <= Number(local.chapters || 0)) {
        // 没有新章节也要刷新元数据/封面，并让宿主更新阅读器书库里的旧条目，
        // 这样以前下载时没封面、作者写成“本地 EPUB”的记录也能被修好。
        const fres = await api("/api/tomato/refresh", { book_id: local.book_id });
        if (fres && fres.ok) {
          for (const [fmt, path] of Object.entries(fres.formats || {})) {
            if (state.allowed.has(fmt)) await postHost("host.importBook", { path, format: fmt });
          }
        }
        $("progressCard").hidden = false;
        $("phaseText").textContent = "已是最新";
        $("percentText").textContent = "100%";
        $("progressBar").style.width = "100%";
        $("progressInfo").textContent = "《" + (local.book_name || info.book_name || "") + "》没有新章节";
        $("progressMessage").textContent = "已刷新书名/作者/封面，并同步到阅读器书库";
        await loadLibrary();
        setTimeout(() => { $("progressCard").hidden = true; }, 2500);
        return;
      }
      state.book = { ...local, ...info, book_id: local.book_id };
      $("detail").hidden = false;
      $("bookTitle").textContent = info.book_name || local.book_name;
      $("bookMeta").textContent = "作者：" + (info.author || local.author || "未知") + " · 共 " + total + " 章";
      $("bookAbstract").textContent = info.abstract || "";
      $("startChapter").value = String(Number(local.chapters || 0) + 1);
      $("endChapter").value = String(total);
      await startDownload();
    } catch (e) {
      $("progressCard").hidden = false;
      $("phaseText").textContent = "更新失败";
      $("progressMessage").textContent = e.message || String(e);
      $("doneCard").hidden = true;
    }
  }

  function pollJob() {
    clearTimeout(state.jobTimer);
    state.jobTimer = setTimeout(async () => {
      try {
        const data = await api("/api/tomato/status");
        const job = (data && data.job) || {};
        const pct = Number(job.percent || 0);
        $("phaseText").textContent = job.phase || "下载中";
        $("percentText").textContent = pct.toFixed(1) + "%";
        $("progressBar").style.width = Math.max(0, Math.min(100, pct)) + "%";
        const counts = job.total ? ` · ${job.current || 0}/${job.total} 章` : "";
        const success = ` · 成功 ${job.success || 0} · 失败 ${job.failed || 0}`;
        $("progressInfo").textContent = (job.book_name ? "《" + job.book_name + "》" : "") + counts + success;
        $("progressMessage").textContent = job.message || job.current_title || "";
        if (job.running) { pollJob(); return; }
        $("downloadBtn").disabled = false;
        if (job.done && job.ok) {
          await handleJobDone(job);
        } else {
          $("phaseText").textContent = job.phase || "失败";
          $("progressMessage").textContent = job.error || "下载失败";
        }
      } catch (e) {
        $("progressMessage").textContent = "状态查询失败：" + (e.message || e);
        pollJob();
      }
    }, 700);
  }

  async function handleJobDone(job) {
    const outputs = job.outputs || {};
    $("doneCard").hidden = false;
    $("doneInfo").textContent = "《" + (job.book_name || "") + "》已生成：" + Object.keys(outputs).map((k) => FORMAT_LABEL[k] || k).join(" / ");
    $("importResults").innerHTML = "";
    for (const [fmt, path] of Object.entries(outputs)) {
      if (!state.allowed.has(fmt)) continue;
      const line = document.createElement("div");
      line.className = "import-item";
      line.textContent = "正在导入 " + (FORMAT_LABEL[fmt] || fmt) + " …";
      $("importResults").appendChild(line);
      const res = await postHost("host.importBook", { path, format: fmt });
      if (res && res.ok) {
        line.className = "import-item ok";
        line.textContent = FORMAT_LABEL[fmt] + " 已加入「" + (res.extensionId || "阅读器") + "」书库：" + (res.title || "");
      } else {
        line.className = "import-item bad";
        line.textContent = FORMAT_LABEL[fmt] + " 导入失败：" + ((res && res.error) || "宿主未响应");
      }
    }
    $("progressBar").style.width = "100%";
    $("percentText").textContent = "100%";
    $("phaseText").textContent = "完成";
    loadLibrary();
  }

  async function cancelDownload() {
    $("cancelBtn").disabled = true;
    try { await api("/api/tomato/cancel", {}); } catch { }
    $("progressMessage").textContent = "正在取消…";
  }

  async function registerIdentity() {
    $("identityBtn").disabled = true;
    try {
      const data = await api("/api/tomato/identity", {});
      $("identityText").textContent = data && data.ok ? "已换匿名设备" : "换设备失败";
      setTimeout(loadIdentity, 800);
    } catch (e) { $("identityText").textContent = "换设备失败：" + (e.message || e); }
    finally { $("identityBtn").disabled = false; }
  }

  async function loadIdentity() {
    try {
      const data = await api("/api/tomato/status");
      const job = (data && data.job) || {};
      $("identityText").textContent = job.message || "匿名设备已就绪";
    } catch (e) { $("identityText").textContent = "后端未连接"; }
  }

  function bind() {
    $("searchBtn").addEventListener("click", search);
    $("searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
    $("backBtn").addEventListener("click", () => { $("detail").hidden = true; });
    $("downloadBtn").addEventListener("click", startDownload);
    $("cancelBtn").addEventListener("click", cancelDownload);
    $("identityBtn").addEventListener("click", registerIdentity);
    $("libraryRefreshBtn").addEventListener("click", loadLibrary);
  }

  bind();
  loadPrerequisites();
  loadIdentity();
  loadLibrary();
})();
