"""
DocGrab — SlideShare & Scribd PDF Downloader
Clean, simple server. No cookies, no proxies, no bloat.

SlideShare: Jina Reader API → CDN image download → pure Python PDF
Scribd:     Selenium headless Chrome → embed page render → CDP PDF export
"""

import os
import re
import json
import struct
import uuid
import time
import base64
import tempfile
import shutil
import requests
from io import BytesIO
from urllib.parse import unquote, urlparse
from flask import Flask, request, jsonify, send_file, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=BASE_DIR, static_url_path='')

DOWNLOAD_DIR = os.path.join(BASE_DIR, 'downloads')
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'


def slugify(text):
    text = re.sub(r'[^\w\s-]', '', text)
    return re.sub(r'[\s_]+', '-', text.strip())[:80] or 'document'


# ══════════════════════════════════════════════════════════════════════
#  JPEG reader + Pure Python PDF builder (no Pillow, no img2pdf)
# ══════════════════════════════════════════════════════════════════════

def get_jpeg_dimensions(data):
    if len(data) < 10 or data[:2] != b'\xff\xd8':
        return None, None
    i = 2
    while i < len(data) - 9:
        if data[i] != 0xff:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xd9, 0xda):
            break
        if 0xc0 <= marker <= 0xc3:
            h = struct.unpack('>H', data[i + 5:i + 7])[0]
            w = struct.unpack('>H', data[i + 7:i + 9])[0]
            return w, h
        if i + 3 < len(data):
            length = struct.unpack('>H', data[i + 2:i + 4])[0]
            i += 2 + length
        else:
            break
    return None, None


def build_pdf_from_jpegs(jpeg_list):
    if not jpeg_list:
        return None
    output = BytesIO()
    output.write(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    cat, pgs, obj = 1, 2, 3
    offsets, refs, pages = {}, [], []

    for img in jpeg_list:
        w, h = get_jpeg_dimensions(img)
        if not w or not h:
            w, h = 638, 479
        p, x, c = obj, obj + 1, obj + 2
        obj += 3
        refs.append(p)
        pages.append({'p': p, 'x': x, 'c': c, 'd': img, 'w': w, 'h': h})

    def wobj(n, d):
        offsets[n] = output.tell()
        output.write(f'{n} 0 obj\n'.encode())
        output.write(d if isinstance(d, bytes) else d.encode())
        output.write(b'\nendobj\n')

    wobj(cat, f'<< /Type /Catalog /Pages {pgs} 0 R >>')
    kids = ' '.join(f'{r} 0 R' for r in refs)
    wobj(pgs, f'<< /Type /Pages /Kids [{kids}] /Count {len(refs)} >>')

    for pg in pages:
        cs = f'q {pg["w"]} 0 0 {pg["h"]} 0 0 cm /Img Do Q'.encode()
        wobj(pg['p'], f'<< /Type /Page /Parent {pgs} 0 R /MediaBox [0 0 {pg["w"]} {pg["h"]}] '
                      f'/Contents {pg["c"]} 0 R /Resources << /XObject << /Img {pg["x"]} 0 R >> >> >>')
        im = pg['d']
        offsets[pg['x']] = output.tell()
        output.write(f'{pg["x"]} 0 obj\n<< /Type /XObject /Subtype /Image /Width {pg["w"]} /Height {pg["h"]} '
                     f'/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(im)} >>\nstream\n'.encode())
        output.write(im)
        output.write(b'\nendstream\nendobj\n')
        wobj(pg['c'], f'<< /Length {len(cs)} >>\nstream\n'.encode() + cs + b'\nendstream')

    xref = output.tell()
    output.write(f'xref\n0 {obj}\n'.encode())
    output.write(b'0000000000 65535 f \n')
    for i in range(1, obj):
        output.write(f'{offsets.get(i, 0):010d} 00000 {"n" if i in offsets else "f"} \n'.encode())
    output.write(f'trailer\n<< /Size {obj} /Root {cat} 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return output.getvalue()


# ══════════════════════════════════════════════════════════════════════
#  SLIDESHARE — Jina Reader + CDN download
# ══════════════════════════════════════════════════════════════════════

def download_slideshare(url):
    # Step 1: Render page via Jina Reader (bypasses Cloudflare)
    resp = requests.get(f"https://r.jina.ai/{url}",
                        headers={'Accept': 'text/html', 'X-Return-Format': 'html'}, timeout=45)
    if resp.status_code != 200:
        return None, "Failed to fetch SlideShare page."

    html = resp.text
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')

    # Step 2: Find slide images
    base_url = title_slug = None
    page_nums = set()

    for img in soup.find_all('img'):
        src = img.get('srcset', '').split(',')[-1].strip().split(' ')[0] if img.get('srcset') else img.get('src', '')
        if 'slidesharecdn' not in src:
            continue
        m = re.search(r'(https://image\.slidesharecdn\.com/[^/]+)/\d+/(.+)-(\d+)-\d+\.jpg', src.split('?')[0])
        if m:
            if not base_url:
                base_url, title_slug = m.group(1), m.group(2)
            page_nums.add(int(m.group(3)))

    # Fallback: regex on raw HTML
    if not base_url:
        for u in re.findall(r'https://image\.slidesharecdn\.com/[^"\'<>\s\)\]]+', html):
            m = re.search(r'(https://image\.slidesharecdn\.com/[^/]+)/\d+/(.+)-(\d+)-\d+\.jpg', u.split('?')[0])
            if m:
                if not base_url:
                    base_url, title_slug = m.group(1), m.group(2)
                page_nums.add(int(m.group(3)))

    if not base_url or not page_nums:
        return None, "Could not find slide images. URL may be invalid."

    # Step 3: Get title
    t = soup.find('title')
    title = t.get_text(strip=True) if t else title_slug.replace('-', ' ')
    for s in [' | PPT', ' - PowerPoint', ' | PDF', ' | SlideShare']:
        title = title.split(s)[0]
    if not title or 'challenge' in title.lower():
        title = title_slug.replace('-', ' ')

    # Step 4: Download all slides as JPEG
    jpegs = []
    session = requests.Session()
    session.headers['User-Agent'] = UA
    for n in range(1, max(page_nums) + 1):
        try:
            r = session.get(f"{base_url}/85/{title_slug}-{n}-638.jpg", timeout=15)
            if r.status_code == 200 and r.content[:2] == b'\xff\xd8':
                jpegs.append(r.content)
            else:
                r2 = session.get(f"{base_url}/85/{title_slug}-{n}-320.jpg", timeout=10)
                if r2.status_code == 200 and r2.content[:2] == b'\xff\xd8':
                    jpegs.append(r2.content)
        except Exception:
            continue

    if not jpegs:
        return None, "Failed to download slide images."

    # Step 5: Build PDF
    pdf = build_pdf_from_jpegs(jpegs)
    if not pdf:
        return None, "Failed to build PDF."

    filename = f"{slugify(title)}_{uuid.uuid4().hex[:6]}.pdf"
    filepath = os.path.join(DOWNLOAD_DIR, filename)
    with open(filepath, 'wb') as f:
        f.write(pdf)

    return {
        'filename': filename, 'title': title,
        'pages': len(jpegs), 'size': f"{len(pdf)/1024/1024:.1f} MB",
        'download_url': f"/api/file/{filename}"
    }, None


# ══════════════════════════════════════════════════════════════════════
#  SCRIBD — Selenium headless Chrome (no login needed)
#  Based on: fullstackusama/scribd-downloader (99★)
# ══════════════════════════════════════════════════════════════════════

def _find_chrome():
    for name in ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable', 'chrome']:
        path = shutil.which(name)
        if path:
            return path
    candidates = [
        # Windows
        os.path.expandvars(r'%ProgramFiles%\Google\Chrome\Application\chrome.exe'),
        os.path.expandvars(r'%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe'),
        os.path.expandvars(r'%LocalAppData%\Google\Chrome\Application\chrome.exe'),
        os.path.expandvars(r'%ProgramFiles%\Chromium\Application\chrome.exe'),
        os.path.expandvars(r'%LocalAppData%\Chromium\Application\chrome.exe'),
        # macOS
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        # Linux
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium',
        # Termux
        '/data/data/com.termux/files/usr/bin/chromium-browser',
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def download_scribd(url):
    # Parse doc ID
    match = re.search(r'scribd\.com/(?:document|doc|presentation)/(\d+)', url)
    if not match:
        return None, "Invalid Scribd URL."
    doc_id = match.group(1)
    embed_url = f"https://www.scribd.com/embeds/{doc_id}/content"

    # Get title from URL
    parsed = urlparse(url)
    title = unquote(parsed.path.rstrip('/').split('/')[-1]).replace('-', ' ') or f'Scribd {doc_id}'

    # Check Selenium is available
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
    except ImportError:
        return None, (
            "Selenium is required for Scribd downloads.\n\n"
            "Install:\n"
            "  pip install selenium\n"
            "  # Plus Chrome/Chromium on your system"
        )

    chrome_path = _find_chrome()
    if not chrome_path:
        return None, (
            "Chrome/Chromium not found.\n\n"
            "Install:\n"
            "  Windows: Install Google Chrome\n"
            "  Mac: brew install --cask chromium\n"
            "  Linux: apt install chromium-browser\n"
            "  Termux: pkg install x11-repo tur-repo chromium"
        )

    driver = None
    tmpdir = tempfile.mkdtemp(prefix='docgrab_')

    try:
        # Setup headless Chrome
        options = Options()
        options.binary_location = chrome_path
        options.add_argument('--headless=new')
        options.add_argument('--window-size=1600,2200')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--disable-gpu')
        options.add_argument('--disable-blink-features=AutomationControlled')
        options.add_argument('--hide-scrollbars')
        options.add_argument(f'--user-data-dir={tmpdir}')
        options.add_experimental_option('excludeSwitches', ['enable-automation'])
        options.add_experimental_option('useAutomationExtension', False)

        driver = webdriver.Chrome(options=options)

        # Increase timeout for large PDFs
        executor = getattr(driver, 'command_executor', None)
        if executor:
            cc = getattr(executor, 'client_config', getattr(executor, '_client_config', None))
            if cc:
                cc.timeout = 300

        # Load embed page
        driver.get(embed_url)
        time.sleep(3)

        # Remove cookie/consent banners
        driver.execute_script("""
            ['[class*="cookie"]','[class*="consent"]','[id*="cookie"]',
             '#onetrust-consent-sdk','.cc-window'].forEach(s => {
                try { document.querySelectorAll(s).forEach(e => e.remove()); } catch(x) {}
            });
        """)

        # Scroll through all pages to trigger lazy loading
        scrolled = 0
        stable = 0
        last_total = -1
        while stable < 2:
            pages = driver.find_elements('css selector', "[class*='page']")
            total = len(pages)
            if total == 0:
                return None, "No pages found. Document may be restricted."
            if total == last_total:
                stable += 1
            else:
                stable = 0
            last_total = total
            for i in range(scrolled, total):
                driver.execute_script(
                    "arguments[0].scrollIntoView({behavior:'instant',block:'center'});", pages[i])
                time.sleep(0.15)
            scrolled = total
            time.sleep(0.5)

        page_count = scrolled

        # Remove toolbars and prepare for print
        driver.execute_script("""
            var t = document.querySelector('.toolbar_top'); if(t) t.remove();
            var b = document.querySelector('.toolbar_bottom'); if(b) b.remove();
            document.querySelectorAll('.document_scroller').forEach(el => {
                el.style.position='static'; el.style.overflow='visible';
                el.style.maxHeight='none'; el.style.height='auto';
                el.style.margin='0'; el.style.padding='0';
            });
            var s = document.createElement('style');
            s.textContent = `
                @media print {
                    @page { margin:0; }
                    html,body { margin:0!important; padding:0!important;
                        -webkit-print-color-adjust:exact!important; }
                    .toolbar_top,.toolbar_bottom { display:none!important; }
                    .document_scroller { position:static!important; overflow:visible!important;
                        height:auto!important; max-height:none!important; }
                    .outer_page { margin:0!important; break-inside:avoid!important;
                        break-after:page!important; }
                    .outer_page:last-of-type { break-after:auto!important; }
                }`;
            document.head.appendChild(s);
        """)

        # Wait for render stability
        try:
            driver.set_script_timeout(20)
            driver.execute_async_script("""
                var done=arguments[arguments.length-1], stable=0, last='';
                function check(){
                    var s=JSON.stringify({
                        imgs:Array.from(document.images||[]).filter(i=>!i.complete).length,
                        pgs:document.querySelectorAll("[class*='page']").length
                    });
                    if(s===last) stable++; else stable=0;
                    last=s;
                    if(stable>=3) done(); else setTimeout(check,300);
                }
                (document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve())
                    .finally(()=>setTimeout(check,500));
            """)
        except Exception:
            pass

        # Detect page dimensions
        paper = driver.execute_script("""
            for(var s of ['.outer_page','.newpage',"[class*='page']"]) {
                var el=document.querySelector(s);
                if(el){var r=el.getBoundingClientRect();
                    if(r.width>0&&r.height>0) return {w:r.width/96,h:r.height/96};}
            } return null;
        """)
        pw = max(1.0, round(paper['w'], 3)) if paper else 7.25
        ph = max(1.0, round(paper['h'], 3)) if paper else 10.5

        # Export PDF via Chrome DevTools Protocol
        pdf_opts = {
            'landscape': False, 'displayHeaderFooter': False,
            'printBackground': True, 'scale': 1,
            'paperWidth': pw, 'paperHeight': ph,
            'marginTop': 0, 'marginBottom': 0, 'marginLeft': 0, 'marginRight': 0,
            'preferCSSPageSize': False,
        }

        # Try streamed (handles large docs)
        pdf_bytes = b''
        try:
            result = driver.execute_cdp_cmd('Page.printToPDF', {**pdf_opts, 'transferMode': 'ReturnAsStream'})
            stream = result.get('stream')
            if stream:
                chunks = []
                while True:
                    chunk = driver.execute_cdp_cmd('IO.read', {'handle': stream, 'size': 1024*1024})
                    data = chunk.get('data', '')
                    if not data and chunk.get('eof'):
                        break
                    chunks.append(base64.b64decode(data) if chunk.get('base64Encoded') else data.encode())
                    if chunk.get('eof'):
                        break
                driver.execute_cdp_cmd('IO.close', {'handle': stream})
                pdf_bytes = b''.join(chunks)
        except Exception:
            # Fallback: base64 return
            result = driver.execute_cdp_cmd('Page.printToPDF', {**pdf_opts, 'transferMode': 'ReturnAsBase64'})
            pdf_bytes = base64.b64decode(result.get('data', ''))

        if len(pdf_bytes) < 1000:
            return None, "PDF export returned empty result."

        filename = f"{slugify(title)}_{uuid.uuid4().hex[:6]}.pdf"
        filepath = os.path.join(DOWNLOAD_DIR, filename)
        with open(filepath, 'wb') as f:
            f.write(pdf_bytes)

        return {
            'filename': filename, 'title': title,
            'pages': page_count, 'size': f"{len(pdf_bytes)/1024/1024:.1f} MB",
            'download_url': f"/api/file/{filename}"
        }, None

    except Exception as e:
        return None, f"Browser error: {str(e)}"

    finally:
        if driver:
            try: driver.quit()
            except: pass
        try: shutil.rmtree(tmpdir, ignore_errors=True)
        except: pass


# ══════════════════════════════════════════════════════════════════════
#  ROUTES
# ══════════════════════════════════════════════════════════════════════

@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/api/download', methods=['POST'])
def api_download():
    data = request.get_json()
    if not data or 'url' not in data:
        return jsonify({'error': 'No URL provided'}), 400

    url = data['url'].strip()
    if not url.startswith('http'):
        url = 'https://' + url

    try:
        if 'slideshare' in url:
            result, error = download_slideshare(url)
        elif 'scribd' in url:
            result, error = download_scribd(url)
        else:
            return jsonify({'error': 'Unsupported platform. Use SlideShare or Scribd URLs.'}), 400

        if error:
            return jsonify({'error': error}), 422

        return jsonify({'success': True, **result})

    except requests.exceptions.Timeout:
        return jsonify({'error': 'Request timed out. Try again.'}), 504
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'Connection failed. Check your internet.'}), 502
    except Exception as e:
        return jsonify({'error': f'Error: {str(e)}'}), 500


@app.route('/api/file/<filename>')
def download_file(filename):
    filename = os.path.basename(filename)
    filepath = os.path.join(DOWNLOAD_DIR, filename)
    if not os.path.exists(filepath):
        return jsonify({'error': 'File not found'}), 404
    return send_file(filepath, as_attachment=True, download_name=filename)


@app.route('/api/status')
def status():
    has_chrome = _find_chrome() is not None
    has_selenium = False
    try:
        import selenium
        has_selenium = True
    except ImportError:
        pass

    return jsonify({
        'status': 'running',
        'slideshare': True,
        'scribd': has_chrome and has_selenium,
        'chrome_path': _find_chrome(),
        'selenium': has_selenium,
        'message': (
            'SlideShare ✅ • Scribd ✅' if (has_chrome and has_selenium)
            else f'SlideShare ✅ • Scribd ❌ ({"no Chrome" if not has_chrome else "pip install selenium"})'
        )
    })


# ── Cleanup old downloads ────────────────────────────────────────────

def cleanup():
    now = time.time()
    for f in os.listdir(DOWNLOAD_DIR):
        path = os.path.join(DOWNLOAD_DIR, f)
        if os.path.isfile(path) and (now - os.path.getmtime(path)) > 3600:
            os.remove(path)


if __name__ == '__main__':
    cleanup()
    chrome = _find_chrome()
    has_sel = False
    try:
        import selenium
        has_sel = True
    except ImportError:
        pass

    print()
    print("  ╔════════════════════════════════════════════════╗")
    print("  ║   🚀 DocGrab Server                            ║")
    print("  ║   📍 http://localhost:5000                      ║")
    print("  ╠════════════════════════════════════════════════╣")
    print(f"  ║   SlideShare  ✅ Ready                         ║")
    if chrome and has_sel:
        print(f"  ║   Scribd      ✅ Ready (Chrome found)          ║")
    elif has_sel and not chrome:
        print(f"  ║   Scribd      ❌ Install Chrome/Chromium       ║")
    else:
        print(f"  ║   Scribd      ❌ pip install selenium           ║")
    print("  ╚════════════════════════════════════════════════╝")
    print()

    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
