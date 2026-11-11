// U5 desktop: strings for the cost line, status chips and the richer background tasks panel (EN primary, ID).
const en = {
  "usage.title": "This session",
  "usage.cost": "Cost",
  "usage.costTip": "Estimated from the live price list{group}.",
  "usage.group": ", with your key's group rate x{ratio}",
  "usage.tokens": "Tokens",
  "usage.tokensValue": "{input} in · {output} out",
  "usage.cache": "Cache hits",
  "usage.cacheNone": "none yet",
  "usage.context": "Context used",
  "usage.contextOf": "{pct} of {window}",
  "usage.empty": "Send a message to see cost and tokens.",
  "chip.mode": "Mode: {mode}",
  "chip.trusted": "Trusted folder",
  "chip.untrusted": "Folder not trusted",
  "chip.sandboxOn": "Sandbox on",
  "chip.sandboxOff": "Sandbox off",
  "chip.sandboxOnTip": "Commands run in a protected box that can only change this project.",
  "chip.sandboxOffTip": "Commands run normally. They still ask first when the mode requires it.",
  "chip.web": "Web search on",
  "tasks.runtime": "Running for {time}",
  "tasks.ranFor": "Ran for {time}",
  "tasks.lastLines": "Last lines",
  "tasks.noOutput": "(no output yet)",
  "tasks.count": "{n} running",
} as const
export type StatusKey = keyof typeof en
const id: Record<StatusKey, string> = {
  "usage.title": "Sesi ini",
  "usage.cost": "Biaya",
  "usage.costTip": "Perkiraan dari daftar harga terbaru{group}.",
  "usage.group": ", dengan tarif grup kunci Anda x{ratio}",
  "usage.tokens": "Token",
  "usage.tokensValue": "{input} masuk · {output} keluar",
  "usage.cache": "Cache terpakai",
  "usage.cacheNone": "belum ada",
  "usage.context": "Konteks terpakai",
  "usage.contextOf": "{pct} dari {window}",
  "usage.empty": "Kirim pesan untuk melihat biaya dan token.",
  "chip.mode": "Mode: {mode}",
  "chip.trusted": "Folder dipercaya",
  "chip.untrusted": "Folder belum dipercaya",
  "chip.sandboxOn": "Sandbox aktif",
  "chip.sandboxOff": "Sandbox mati",
  "chip.sandboxOnTip": "Perintah berjalan di kotak terlindung yang hanya bisa mengubah proyek ini.",
  "chip.sandboxOffTip": "Perintah berjalan biasa. Tetap bertanya dulu bila mode mengharuskan.",
  "chip.web": "Pencarian web aktif",
  "tasks.runtime": "Berjalan {time}",
  "tasks.ranFor": "Berjalan selama {time}",
  "tasks.lastLines": "Baris terakhir",
  "tasks.noOutput": "(belum ada keluaran)",
  "tasks.count": "{n} berjalan",
}
export const statusT = (lang: string | undefined) => {
  const dict: Record<StatusKey, string> = lang?.toLowerCase().startsWith("id") ? id : en
  return (key: StatusKey, vars?: Record<string, string | number>) =>
    (dict[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ""))
}
