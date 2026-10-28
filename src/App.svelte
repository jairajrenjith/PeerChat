<script>
  import { onMount, untrack } from 'svelte';
  import { PeerChat, fmtBytes, defaultSignal, MAX_TEXT } from './peer.js';
  import {
    Send, Paperclip, Hash, Users, Settings, Sun, Moon, Monitor, X, Menu, Check, CheckCheck, Clock,
    TriangleAlert, FileText, Download, ChevronDown, RefreshCw, LogOut, Search, Wifi, MessageSquare, ShieldCheck,
  } from '@lucide/svelte';

  const client = new PeerChat();
  const store = client.store;
  const s = $derived($store);

  /* ───── UI state ───── */
  let name = $state('');
  let firstRoom = $state('general');
  let signalUrl = $state('');
  let showAdv = $state(false);
  let starting = $state(false);
  let active = $state(null);
  let query = $state('');
  let draft = $state('');
  let sideOpen = $state(false);
  let panelOpen = $state(false);
  let settingsOpen = $state(false);
  let confirmEnd = $state(false);
  let theme = $state('system');
  let expanded = $state({});
  let dragging = $state(false);
  let scroller = $state(null);
  let composer = $state(null);
  let fileInput = $state(null);
  let stick = true;

  /* ───── derived ───── */
  const rooms = $derived(Object.values(s.rooms).sort((a, b) => b.activity - a.activity));
  const shown = $derived(query.trim() ? rooms.filter((r) => r.name.includes(query.trim().toLowerCase())) : rooms);
  const room = $derived(active ? (s.rooms[active] ?? null) : null);
  const members = $derived(room ? room.members.map((id) => s.peers[id]).filter(Boolean) : []);
  const counts = $derived.by(() => {
    const c = {};
    if (!s.me) return c;
    for (const n of [s.me.name, ...members.map((p) => p.name)]) c[n] = (c[n] || 0) + 1;
    return c;
  });
  const dn = (p) => (counts[p.name] > 1 ? `${p.name} #${p.id.slice(-4)}` : p.name);   // duplicate names get an id suffix

  /* ───── formatting ───── */
  const fmtT = (t, none = 'unavailable') =>
    t ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }) : none;
  const hm = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const hue = (id) => [...id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
  const safeName = (n) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
  const lastMsg = (r) => [...r.messages].reverse().find((m) => m.kind !== 'system');
  const preview = (r) => {
    const m = lastMsg(r);
    if (!m) return 'No messages yet';
    return (m.dir === 'out' ? 'You: ' : '') + (m.kind === 'file' ? `File: ${m.file.name}` : m.text);
  };
  const badge = {
    connected: ['Direct', 'bg-ok/15 text-ok'],
    connecting: ['Connecting…', 'bg-warn/15 text-warn animate-pulse'],
    unstable: ['Unstable', 'bg-warn/15 text-warn'],
    failed: ['Failed', 'bg-bad/15 text-bad'],
  };
  const tone = { ok: 'text-ok', bad: 'text-bad', warn: 'text-warn', busy: 'text-muted' };

  const pct = (m) => {
    if (m.dir === 'in') return m.size ? Math.min(100, Math.round((m.bytes / m.size) * 100)) : 100;
    const r = Object.values(m.recips).filter((x) => x.status !== 'failed');
    if (!r.length || !m.size) return r.length ? 100 : 0;
    return Math.min(100, Math.round((r.reduce((a, x) => a + (x.bytes || 0), 0) / r.length / m.size) * 100));
  };
  const busy = (m) =>
    m.kind === 'file' && (m.dir === 'in' ? m.status === 'receiving' : Object.values(m.recips).some((r) => r.status === 'sending' || r.status === 'verifying'));

  function statusOf(m) {
    if (m.dir === 'in') {
      if (m.kind === 'text') return null;
      if (m.status === 'receiving') return { k: 'busy', text: `Receiving… ${pct(m)}%` };
      if (m.status === 'done') return { k: 'ok', text: 'Received · SHA-256 verified' };
      return { k: 'bad', text: m.error || 'Transfer failed' };
    }
    const r = Object.values(m.recips), n = r.length, c = (st) => r.filter((x) => x.status === st).length;
    if (!n) return { k: 'warn', text: 'Not sent — nobody else is in this room' };
    const d = c('delivered'), f = c('failed');
    if (d === n) return { k: 'ok', text: m.kind === 'file' ? 'Delivered · integrity verified' : n > 1 ? `Delivered to all ${n}` : 'Delivered' };
    if (f === n) return { k: 'bad', text: r[0].error ? `Failed — ${r[0].error}` : 'Failed' };
    if (d + f === n) return { k: 'warn', text: `Delivered to ${d} of ${n} · ${f} failed` };
    if (m.kind === 'file') return { k: 'busy', text: c('verifying') && !c('sending') ? 'Verifying…' : `Sending… ${pct(m)}%` };
    return { k: 'busy', text: c('sending') ? 'Sending…' : d ? `Sent · ${d} of ${n} delivered` : 'Sent · awaiting acknowledgment' };
  }

  /* ───── P2P details (only real, observed values; otherwise "unavailable") ───── */
  const cand = (t, a) => (t || a ? `${t ?? 'unknown'}${a ? ' · ' + a : ''}` : null);
  const pathLabel = (n) => (n?.path === 'direct' ? 'Direct (no relay)' : n?.path === 'relayed' ? 'Relayed' : null);
  const netRows = (n) =>
    n
      ? [['PeerConnection', n.pc], ['ICE connection', n.ice], ['DataChannel', n.dc], ['Selected path', pathLabel(n)],
         ['Local candidate', cand(n.localType, n.local)], ['Remote candidate', cand(n.remoteType, n.remote)],
         ['Protocol', n.protocol], ['Round-trip time', n.rtt != null ? `${n.rtt} ms` : null]]
      : [['Connection info', null]];

  function detailSections(m) {
    const me = s.me;
    const head = [
      ['Direction', m.dir === 'out' ? 'Outgoing (sender-side view)' : 'Incoming (receiver-side view)'],
      [m.kind === 'file' ? 'File ID' : 'Message ID', m.id],
      ['Local peer', `${me.name} · ${me.id}`],
    ];
    const out = [];
    if (m.dir === 'out') {
      head.push(['Created (local clock)', fmtT(m.ts)]);
      head.push(m.kind === 'file' ? ['File', `${m.file.name} · ${fmtBytes(m.size)} (${m.size} B)`] : ['Payload size', `${m.size} B (JSON frame)`]);
      out.push({ title: 'Overview', rows: head });
      for (const r of Object.values(m.recips)) {
        const rows = [['Remote peer', `${r.name} · ${r.id}`], ['Status', r.status]];
        if (m.kind === 'file')
          rows.push(['Transfer started (local)', fmtT(r.startedAt, 'not started')], ['Last chunk submitted (local)', fmtT(r.sentAt, 'not yet')],
            ['Completed (local)', fmtT(r.doneAt, 'not yet')], ['Bytes transferred', `${r.bytes} / ${m.size}`],
            ['SHA-256 (computed by sender)', r.sha256], ['Receiver confirmed integrity', r.verified ? 'yes' : r.status === 'failed' ? 'no' : 'pending']);
        else
          rows.push(['Submitted to DataChannel (local)', fmtT(r.sentAt, 'not sent')], ['Ack received (local clock)', fmtT(r.ackAt, 'no ack yet')],
            ['Ack time reported by receiver (remote clock, unverified)', fmtT(r.remoteAckTs, 'none')]);
        rows.push(['Error', r.error ?? 'none'], ...netRows(r.snap));
        out.push({ title: `To ${r.name}`, rows });
      }
    } else {
      head.push(['Remote peer (sender)', `${m.from.name} · ${m.from.id}`], ['Received (local clock)', fmtT(m.ts)],
        ['Sender-reported time (remote clock, unverified)', fmtT(m.remoteTs)]);
      if (m.kind === 'text') head.push(['Payload size', `${m.size} B (JSON frame)`], ['Acknowledgment sent (local)', fmtT(m.ackAt, 'not sent')]);
      else
        head.push(['File', `${m.file.name} · ${fmtBytes(m.size)} (${m.size} B)`], ['Status', m.status], ['Bytes received', `${m.bytes} / ${m.size}`],
          ['Transfer started (local)', fmtT(m.startedAt)], ['Completed (local)', fmtT(m.doneAt, 'not yet')],
          ['SHA-256 declared by sender', m.sha256Remote], ['SHA-256 computed by receiver', m.sha256Local],
          ['Integrity check', m.verified === true ? 'passed' : m.verified === false ? 'FAILED' : 'pending'], ['Error', m.error ?? 'none']);
      out.push({ title: 'Overview', rows: head }, { title: 'Connection when received', rows: netRows(m.snap) });
    }
    return out;
  }

  /* ───── actions ───── */
  async function begin(e) {
    e.preventDefault();
    starting = true;
    await client.start(name, signalUrl);
    active = client.join(firstRoom || 'general');
    starting = false;
  }
  function joinRoom(e) {
    e.preventDefault();
    const r = client.join(query);
    if (r) { active = r; query = ''; sideOpen = false; }
  }
  function leaveRoom() {
    if (!active) return;
    client.leave(active);
    active = null;
  }
  function endSession() {
    if (!confirmEnd) { confirmEnd = true; return; }
    client.quit();
    active = null; settingsOpen = false; panelOpen = false; sideOpen = false; expanded = {}; confirmEnd = false;
  }
  function submit() {
    const t = draft.trim();
    if (!t || !active) return;
    client.send(active, t.slice(0, MAX_TEXT));
    draft = ''; stick = true;
    if (composer) composer.style.height = 'auto';
  }
  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  }
  function grow(e) {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
  }
  function pick(e) {
    const files = [...e.currentTarget.files];
    e.currentTarget.value = '';
    if (files.length && active) { client.sendFiles(active, files); stick = true; }
  }
  function onDrop(e) {
    e.preventDefault(); dragging = false;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length && active) { client.sendFiles(active, files); stick = true; }
  }
  const onScroll = (e) => { stick = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 80; };

  /* ───── effects ───── */
  onMount(async () => {
    try { theme = localStorage.getItem('pc-theme') || 'system'; } catch {}
    signalUrl = await defaultSignal();
  });
  $effect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    try { localStorage.setItem('pc-theme', theme); } catch {}
    return () => mq.removeEventListener('change', apply);
  });
  $effect(() => { if (s.me && (!active || !s.rooms[active])) active = rooms[0]?.name ?? null; });
  $effect(() => { client.setActive(active); stick = true; });
  $effect(() => {
    room?.messages;   // re-run on any change in the active room
    if (scroller && stick) requestAnimationFrame(() => { if (scroller) scroller.scrollTop = scroller.scrollHeight; });
  });
  $effect(() => {     // refresh observed ICE info while the panel is open
    if (!panelOpen || !active) return;
    const r = active;
    const run = () => untrack(() => client.refreshNet(s.rooms[r]?.members ?? []));
    run();
    const iv = setInterval(run, 4000);
    return () => clearInterval(iv);
  });
</script>

<svelte:window
  onkeydown={(e) => { if (e.key === 'Escape') { settingsOpen = false; confirmEnd = false; } }}
  onfocus={() => client.setActive(active)} />

<!-- ───── snippets ───── -->
{#snippet themeSwitch()}
  <div class="inline-flex rounded-xl border border-line bg-panel2 p-1" role="group" aria-label="Theme">
    {#each [['light', Sun, 'Light'], ['dark', Moon, 'Dark'], ['system', Monitor, 'System']] as [v, Icon, label]}
      <button type="button" class="btn px-3 py-1.5 {theme === v ? 'bg-panel text-ink shadow-sm' : 'text-muted'}"
        aria-pressed={theme === v} onclick={() => (theme = v)}>
        <Icon size={15} />{label}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet rows(list)}
  <dl class="text-[11px] leading-5">
    {#each list as [k, v]}
      <div class="flex justify-between gap-3">
        <dt class="shrink-0 text-muted">{k}</dt>
        <dd class="break-all text-right font-mono">{v ?? 'unavailable'}</dd>
      </div>
    {/each}
  </dl>
{/snippet}

{#snippet avatar(p, size)}
  <span class="grid shrink-0 place-items-center rounded-full font-semibold text-white {size}" style="background:hsl({hue(p.id)} 55% 42%)">{initial(p.name)}</span>
{/snippet}

{#snippet fileCard(m, out)}
  {@const p = pct(m)}
  {#if (m.preview || m.url) && m.file.mime.startsWith('image/') && (m.dir === 'out' || m.status === 'done')}
    <img src={m.preview || m.url} alt={m.file.name} class="mb-2 max-h-56 w-full rounded-xl object-cover" />
  {/if}
  <div class="flex min-w-[210px] items-center gap-3">
    <span class="grid size-10 shrink-0 place-items-center rounded-xl {out ? 'bg-white/20' : 'bg-solid/10 text-brand'}"><FileText size={20} /></span>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium">{m.file.name}</p>
      <p class="text-xs {out ? 'text-white/80' : 'text-muted'}">{fmtBytes(m.file.size)}{#if busy(m)} · {p}%{/if}</p>
    </div>
    {#if !out && m.status === 'done'}
      <a class="icon-btn" href={m.url} download={safeName(m.file.name)} title="Save file" aria-label="Save file"><Download size={18} /></a>
    {/if}
    {#if busy(m)}
      <button class="icon-btn {out ? 'text-white! hover:bg-white/20!' : ''}" title="Cancel" aria-label="Cancel transfer" onclick={() => client.cancel(m.room, m.key)}><X size={16} /></button>
    {/if}
  </div>
  {#if busy(m)}
    <div class="mt-2 h-1.5 overflow-hidden rounded-full {out ? 'bg-white/25' : 'bg-line'}">
      <div class="h-full rounded-full transition-all {out ? 'bg-white' : 'bg-solid'}" style="width:{p}%"></div>
    </div>
  {/if}
{/snippet}

{#if !s.me}
  <!-- ───── start screen ───── -->
  <main class="relative grid min-h-dvh place-items-center bg-bg p-4">
    <div class="absolute right-4 top-4">{@render themeSwitch()}</div>
    <form onsubmit={begin} class="w-full max-w-md rounded-3xl border border-line bg-panel p-7 shadow-xl shadow-black/5 sm:p-8">
      <div class="mb-6 flex items-center gap-3">
        <span class="grid size-12 place-items-center rounded-2xl bg-solid text-white"><MessageSquare size={24} /></span>
        <div>
          <h1 class="text-xl font-semibold tracking-tight">PeerChat</h1>
          <p class="text-sm text-muted">Direct peer-to-peer rooms. Nothing is stored.</p>
        </div>
      </div>
      <label class="mb-4 block text-sm font-medium">Display name
        <input class="input mt-1.5" bind:value={name} maxlength="32" placeholder="e.g. Jairaj" required autofocus autocomplete="off" />
      </label>
      <label class="mb-4 block text-sm font-medium">Room to join
        <input class="input mt-1.5" bind:value={firstRoom} maxlength="48" placeholder="general" required autocomplete="off" />
      </label>
      <button type="button" class="mb-3 flex items-center gap-1 text-xs text-muted hover:text-ink" onclick={() => (showAdv = !showAdv)}>
        <ChevronDown size={14} class={showAdv ? 'rotate-180' : ''} /> Signaling server
      </button>
      {#if showAdv}
        <input class="input mb-4 font-mono text-xs" bind:value={signalUrl} placeholder="ws://192.168.1.20:8000/ws" autocomplete="off" />
      {/if}
      <button class="btn btn-primary w-full py-2.5" disabled={starting}>{starting ? 'Starting…' : 'Start session'}</button>
      <p class="mt-4 flex items-start gap-2 text-xs text-muted">
        <ShieldCheck size={15} class="mt-0.5 shrink-0" />
        Messages and files go straight between devices over WebRTC. The server only helps peers find each other.
      </p>
    </form>
  </main>
{:else}
  <div class="flex h-dvh overflow-hidden bg-bg">
    {#if sideOpen}
      <button class="fixed inset-0 z-20 bg-black/40 md:hidden" aria-label="Close sidebar" onclick={() => (sideOpen = false)}></button>
    {/if}

    <!-- ───── sidebar ───── -->
    <aside class="fixed inset-y-0 left-0 z-30 flex w-80 max-w-[85vw] flex-col border-r border-line bg-panel transition-transform md:static md:translate-x-0 {sideOpen ? '' : '-translate-x-full'}">
      <div class="flex items-center gap-2 px-4 pb-2 pt-4">
        <span class="grid size-9 place-items-center rounded-xl bg-solid text-white"><MessageSquare size={18} /></span>
        <h1 class="flex-1 text-lg font-semibold tracking-tight">PeerChat</h1>
        <button class="icon-btn" title="Settings" aria-label="Settings" onclick={() => (settingsOpen = true)}><Settings size={18} /></button>
      </div>
      <form onsubmit={joinRoom} class="px-4 pb-3">
        <div class="relative">
          <Search size={16} class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input class="input pl-9" bind:value={query} maxlength="48" placeholder="Search or join a room…" autocomplete="off" aria-label="Search or join a room" />
        </div>
        {#if query.trim() && !rooms.some((r) => r.name === query.trim().toLowerCase())}
          <button class="btn btn-ghost mt-2 w-full justify-start text-brand"><Hash size={15} /> Join “{query.trim().toLowerCase()}”</button>
        {/if}
      </form>
      <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {#each shown as r (r.name)}
          {@const last = lastMsg(r)}
          <li>
            <button class="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-panel2 {active === r.name ? 'bg-panel2' : ''}"
              onclick={() => { active = r.name; sideOpen = false; }}>
              <span class="grid size-11 shrink-0 place-items-center rounded-full text-white" style="background:hsl({hue(r.name)} 55% 42%)"><Hash size={18} /></span>
              <span class="min-w-0 flex-1">
                <span class="flex items-baseline justify-between gap-2">
                  <span class="truncate font-medium">{r.name}</span>
                  {#if last}<span class="shrink-0 text-[11px] text-muted">{hm(last.ts)}</span>{/if}
                </span>
                <span class="flex items-center justify-between gap-2">
                  <span class="truncate text-xs text-muted">{preview(r)}</span>
                  {#if r.unread}<span class="chip bg-solid text-white">{r.unread}</span>{/if}
                </span>
              </span>
            </button>
          </li>
        {:else}
          <li class="px-4 py-8 text-center text-sm text-muted">No rooms match. Press Enter to join “{query.trim()}”.</li>
        {/each}
      </ul>
      <div class="flex items-center gap-3 border-t border-line p-3">
        {@render avatar(s.me, 'size-10 text-sm')}
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">{s.me.name}</p>
          <p class="flex items-center gap-1.5 text-[11px] text-muted">
            <span class="size-2 rounded-full {s.signal.state === 'online' ? 'bg-ok' : s.signal.state === 'connecting' ? 'animate-pulse bg-warn' : 'bg-bad'}"></span>
            Signaling {s.signal.state} · {s.me.id.slice(-4)}
          </p>
        </div>
      </div>
    </aside>

    <!-- ───── chat ───── -->
    <main class="relative flex min-w-0 flex-1 flex-col"
      ondragover={(e) => { e.preventDefault(); if (room) dragging = true; }}
      ondragleave={(e) => { if (e.currentTarget === e.target) dragging = false; }}
      ondrop={onDrop}>
      {#if room}
        <header class="flex items-center gap-2 border-b border-line bg-panel px-3 py-2.5 sm:px-4">
          <button class="icon-btn md:hidden" aria-label="Open rooms" onclick={() => (sideOpen = true)}><Menu size={20} /></button>
          <span class="grid size-10 shrink-0 place-items-center rounded-full text-white" style="background:hsl({hue(room.name)} 55% 42%)"><Hash size={18} /></span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate font-semibold">{room.name}</h2>
            <p class="truncate text-xs text-muted">
              {members.length + 1} in room · {members.filter((p) => p.status === 'connected').length} of {members.length} connected directly
            </p>
          </div>
          <button class="icon-btn {panelOpen ? 'bg-panel2 text-ink' : ''}" title="People & network" aria-label="People and network" onclick={() => (panelOpen = !panelOpen)}><Users size={19} /></button>
          <button class="icon-btn" title="Leave room (discards its messages)" aria-label="Leave room" onclick={leaveRoom}><LogOut size={18} /></button>
        </header>

        {#if s.signal.state !== 'online'}
          <div class="flex items-center gap-2 bg-warn/15 px-4 py-2 text-xs text-warn">
            <Wifi size={14} /> Signaling server {s.signal.state === 'connecting' ? 'connecting' : 'offline — retrying'}. Existing direct connections keep working; new people can't be discovered yet.
          </div>
        {/if}

        <div bind:this={scroller} onscroll={onScroll} class="flex-1 space-y-3 overflow-y-auto px-3 py-4 sm:px-6">
          {#if !room.messages.length}
            <div class="grid h-full place-items-center text-center text-sm text-muted">
              <div>
                <p class="mb-1 text-base font-medium text-ink">Welcome to #{room.name}</p>
                <p>{members.length ? 'Say hi — messages go straight to everyone here.' : 'Waiting for others. Share the room name with them.'}</p>
              </div>
            </div>
          {/if}
          {#each room.messages as m (m.key)}
            {#if m.kind === 'system'}
              <div class="text-center"><span class="chip bg-panel2 text-muted">{m.text}</span></div>
            {:else}
              {@const out = m.dir === 'out'}
              {@const st = statusOf(m)}
              <div class="msg-in flex gap-2 {out ? 'justify-end' : 'justify-start'}">
                {#if !out}{@render avatar(m.from, 'mt-5 size-8 text-xs')}{/if}
                <div class="max-w-[88%] sm:max-w-[70%]">
                  {#if !out}<p class="mb-0.5 ml-1 text-xs font-medium text-muted">{dn(m.from)}</p>{/if}
                  <div class="rounded-2xl px-3.5 py-2 shadow-sm {out ? 'rounded-br-md bg-solid text-white' : 'rounded-bl-md border border-line bg-bubble text-ink'}">
                    {#if m.kind === 'text'}
                      <p class="whitespace-pre-wrap break-words text-[15px] leading-snug">{m.text}</p>
                    {:else}
                      {@render fileCard(m, out)}
                    {/if}
                    <p class="mt-1 text-right text-[11px] {out ? 'text-white/80' : 'text-muted'}">{hm(m.ts)}</p>
                  </div>
                  <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-[11px] {out ? 'justify-end' : ''}">
                    {#if st}
                      <span class="inline-flex items-center gap-1 {tone[st.k]}">
                        {#if st.k === 'ok'}<CheckCheck size={13} />{:else if st.k === 'bad' || st.k === 'warn'}<TriangleAlert size={13} />{:else}<Clock size={13} />{/if}
                        {st.text}
                      </span>
                    {/if}
                    <button class="inline-flex items-center gap-1 text-muted hover:text-ink" aria-expanded={!!expanded[m.key]} onclick={() => (expanded[m.key] = !expanded[m.key])}>
                      <ChevronDown size={12} class={expanded[m.key] ? 'rotate-180' : ''} /> P2P Details
                    </button>
                  </div>
                  {#if expanded[m.key]}
                    <div class="mt-2 space-y-2 rounded-2xl border border-line bg-panel p-3">
                      {#each detailSections(m) as sec}
                        <div>
                          <p class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-brand">{sec.title}</p>
                          {@render rows(sec.rows)}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          {/each}
        </div>

        <form class="flex items-end gap-2 border-t border-line bg-panel p-3 sm:px-4" onsubmit={(e) => { e.preventDefault(); submit(); }}>
          <input bind:this={fileInput} type="file" multiple class="hidden" onchange={pick} />
          <button type="button" class="icon-btn" title="Attach files" aria-label="Attach files" onclick={() => fileInput.click()}><Paperclip size={19} /></button>
          <textarea bind:this={composer} bind:value={draft} rows="1" maxlength={MAX_TEXT} oninput={grow} onkeydown={onKey}
            class="input max-h-36 min-h-10 flex-1 resize-none py-2.5" placeholder="Message #{room.name}" aria-label="Message"></textarea>
          <button class="btn btn-primary size-10 shrink-0 p-0" aria-label="Send" disabled={!draft.trim()}><Send size={18} /></button>
        </form>

        {#if dragging}
          <div class="pointer-events-none absolute inset-0 z-10 grid place-items-center border-2 border-dashed border-brand bg-bg/80 text-lg font-medium text-brand">
            Drop files to send to #{room.name}
          </div>
        {/if}
      {:else}
        <header class="flex items-center gap-2 border-b border-line bg-panel p-2.5 md:hidden">
          <button class="icon-btn" aria-label="Open rooms" onclick={() => (sideOpen = true)}><Menu size={20} /></button>
          <span class="font-semibold">PeerChat</span>
        </header>
        <div class="grid flex-1 place-items-center p-6 text-center">
          <div>
            <span class="mx-auto mb-4 grid size-16 place-items-center rounded-3xl bg-solid/10 text-brand"><Hash size={30} /></span>
            <p class="text-lg font-semibold">No room selected</p>
            <p class="mt-1 text-sm text-muted">Type a room name in the sidebar and press Enter to join.</p>
          </div>
        </div>
      {/if}
    </main>

    <!-- ───── right panel: people + network ───── -->
    {#if panelOpen && room}
      <button class="fixed inset-0 z-20 bg-black/40 xl:hidden" aria-label="Close panel" onclick={() => (panelOpen = false)}></button>
      <aside class="fixed inset-y-0 right-0 z-30 flex w-[22rem] max-w-[92vw] flex-col border-l border-line bg-panel shadow-2xl xl:static xl:shadow-none">
        <div class="flex items-center justify-between px-4 py-3">
          <h3 class="font-semibold">People &amp; network</h3>
          <button class="icon-btn" aria-label="Close panel" onclick={() => (panelOpen = false)}><X size={18} /></button>
        </div>
        <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          <section class="rounded-2xl border border-line p-3">
            <p class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-brand">Signaling (control plane)</p>
            {@render rows([['Server', s.signal.url], ['State', s.signal.state], ['Carries', 'presence + SDP/ICE only']])}
            <p class="mt-2 text-[11px] text-muted">Chat text and files never touch this server — they travel over WebRTC DataChannels.</p>
          </section>

          <section>
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-brand">In this room ({members.length + 1})</p>
            <ul class="space-y-2">
              <li class="flex items-center gap-3 rounded-2xl border border-line p-3">
                {@render avatar(s.me, 'size-9 text-sm')}
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium">{dn(s.me)} <span class="text-muted">(you)</span></p>
                  <p class="font-mono text-[11px] text-muted">{s.me.id}</p>
                </div>
              </li>
              {#each members as p (p.id)}
                <li class="rounded-2xl border border-line p-3">
                  <div class="flex items-center gap-3">
                    {@render avatar(p, 'size-9 text-sm')}
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium">{dn(p)}</p>
                      <p class="truncate font-mono text-[11px] text-muted">{p.id}</p>
                    </div>
                    <span class="chip {(badge[p.status] ?? badge.connecting)[1]}">{(badge[p.status] ?? badge.connecting)[0]}</span>
                  </div>
                  {#if p.status === 'failed'}
                    <p class="mt-2 text-xs text-bad">{p.error}</p>
                    <button class="btn btn-ghost mt-2 w-full" onclick={() => client.retryPeer(p.id)}><RefreshCw size={14} /> Retry direct connection</button>
                  {/if}
                  <div class="mt-2 border-t border-line pt-2">{@render rows(netRows(p))}</div>
                </li>
              {:else}
                <li class="rounded-2xl border border-dashed border-line p-4 text-center text-xs text-muted">Nobody else is here yet.</li>
              {/each}
            </ul>
          </section>
        </div>
      </aside>
    {/if}
  </div>
{/if}

<!-- ───── settings ───── -->
{#if settingsOpen}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) { settingsOpen = false; confirmEnd = false; } }}
    onkeydown={() => {}}>
    <div class="w-full max-w-sm rounded-3xl border border-line bg-panel p-6 shadow-2xl">
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-lg font-semibold">Settings</h3>
        <button class="icon-btn" aria-label="Close" onclick={() => { settingsOpen = false; confirmEnd = false; }}><X size={18} /></button>
      </div>
      <p class="mb-2 text-sm font-medium">Appearance</p>
      {@render themeSwitch()}
      <p class="mt-5 text-xs text-muted">Direct-only mode: connections use STUN for discovery and never a TURN relay. If two networks block direct paths, you'll see a clear error and can retry.</p>
      {#if s.me}
        <button class="btn mt-5 w-full {confirmEnd ? 'bg-bad text-white' : 'btn-ghost text-bad'}" onclick={endSession}>
          <LogOut size={16} /> {confirmEnd ? 'Click again to discard everything' : 'End session'}
        </button>
      {/if}
    </div>
  </div>
{/if}

{#if s.notice}
  <div class="fixed bottom-24 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-xl bg-ink px-4 py-2 text-sm text-bg shadow-lg" role="status">{s.notice.text}</div>
{/if}