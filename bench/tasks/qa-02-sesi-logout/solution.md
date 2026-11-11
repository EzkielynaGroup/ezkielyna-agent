Penyebabnya ada di `src/auth/session.ts`, fungsi `buatSesi`: `kedaluwarsa` dihitung sebagai `Date.now() + SESSION_TTL_DETIK`.
`Date.now()` dalam milidetik, sedangkan `SESSION_TTL_DETIK` (dari `src/config.ts`) dalam detik, jadi sesi hanya berlaku 3600 ms = 3,6 detik.
Perbaikan: kalikan dengan 1000, yaitu `Date.now() + SESSION_TTL_DETIK * 1000`.
