# 🚀 DocGrab — SlideShare & Scribd PDF Downloader

Glassmorphism web app that downloads PDFs from SlideShare and Scribd. No login, no cookies, no subscription.

## ⚡ Setup

```bash
pip install flask requests beautifulsoup4 selenium
python server.py
```
Open **http://localhost:5000**

> Scribd requires Chrome/Chromium installed on your system.

## How It Works

**SlideShare** — Jina Reader bypasses Cloudflare → downloads slide JPEGs from CDN → builds PDF in pure Python

**Scribd** — Opens embed page in headless Chrome → scrolls all pages → exports PDF via Chrome DevTools Protocol. **No account needed.**

## Files

| File | What |
|------|------|
| `server.py` | Flask backend — all logic in one file |
| `index.html` | Glassmorphism frontend |
| `requirements.txt` | Python deps |

## Credits

- SlideShare pattern: [yodiaditya/slideshare-downloader](https://github.com/yodiaditya/slideshare-downloader)
- Scribd method: [fullstackusama/scribd-downloader](https://github.com/fullstackusama/scribd-downloader)

Or you can use my website 
https://docgrab.up.railway.app/
