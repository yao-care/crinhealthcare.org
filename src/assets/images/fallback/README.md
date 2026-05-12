# Fallback Images

This directory holds pre-downloaded backup images used by `scripts/fetch-images.ts`
when the Unsplash API returns no results or is unavailable (e.g., rate limit exceeded,
missing API key, or network error).

## Naming Convention

Files should be named `{collection}-default.webp`, for example:

- `services-default.webp`
- `news-default.webp`
- `insights-default.webp`
- `case-studies-default.webp`

## How to populate

Download suitable royalty-free images from Unsplash or another source and resize
them to 1200×630 WebP (80% quality) using sharp or an equivalent tool.

At build time, `fetch-images.ts` checks for a matching fallback before giving up,
so keeping at least one generic image per collection ensures no hero slot is left empty.
