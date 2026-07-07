"""
DocGrab Backend Server
Downloads PDFs from SlideShare and Scribd
"""

import os
import re
import json
import time
import uuid
import requests
import img2pdf
from io import BytesIO
from urllib.parse import urlparse, unquote
from flask import Flask, request, jsonify, send_file, send_from_directory
from bs4 import BeautifulSoup

app = Flask(__name__, static_folder='.', static_url_path='')

DOWNLOAD_DIR = os.path.join(os.path.dirname(__file__), 'downloads')
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
}


def slugify(text):
    """Create a safe filename from text."""
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text.strip())
    return text[:80] or 'document'


# ─── SlideShare Downloader ────────────────────────────────────────────

def download_slideshare(url):
    """
    SlideShare embeds slide images in the page.
    We extract all slide images, download them, and compile into a PDF.
    """
    session = requests.Session()
    session.headers.update(HEADERS)

    resp = session.get(url, timeout=20)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, 'html.parser')

    # Get title
    title_tag = soup.find('title')
    title = title_tag.get_text(strip=True) if title_tag else 'SlideShare Document'
    title = title.replace(' | PPT', '').replace(' - PowerPoint PPT Presentation', '').strip()

    # Strategy 1: Look for slide images in picture/source/img tags
    image_urls = []

    # Look for high-res slide images in various patterns
    # SlideShare uses data attributes and srcset for slide images
    for img in soup.find_all('img'):
        src = img.get('data-full') or img.get('data-normal') or img.get('srcset', '').split(',')[-1].strip().split(' ')[0] or img.get('src', '')
        if src and ('slideserve' in src or 'slidesharecdn' in src or 'slide_' in src or '/slide/' in src):
            if src.startswith('//'):
                src = 'https:' + src
            image_urls.append(src)

    # Strategy 2: Look in JSON-LD or script tags for image data
    if not image_urls:
        for script in soup.find_all('script'):
            text = script.string or ''
            # Look for image arrays in JavaScript
            matches = re.findall(r'https?://[^"\']+(?:slidecdn|slidesharecdn|slide)[^"\']*\.(?:jpg|jpeg|png|webp)', text)
            image_urls.extend(matches)

    # Strategy 3: Look for srcset attributes broadly
    if not image_urls:
        for source in soup.find_all(['source', 'img']):
            srcset = source.get('srcset', '')
            src = source.get('src', '')
            for s in [srcset, src]:
                if s and ('cdn' in s or 'image' in s) and any(ext in s.lower() for ext in ['.jpg', '.jpeg', '.png', '.webp']):
                    clean_url = s.split(',')[-1].strip().split(' ')[0]
                    if clean_url.startswith('//'):
                        clean_url = 'https:' + clean_url
                    if clean_url.startswith('http'):
                        image_urls.append(clean_url)

    # Strategy 4: Look for Open Graph / meta images as fallback
    if not image_urls:
        for meta in soup.find_all('meta'):
            content = meta.get('content', '')
            if content and ('slidecdn' in content or 'slidesharecdn' in content) and any(ext in content for ext in ['.jpg', '.png', '.webp']):
                image_urls.append(content)

    # Deduplicate while preserving order
    seen = set()
    unique_urls = []
    for u in image_urls:
        # Normalize URL
        u = u.split('?')[0]  # Remove query params for dedup
        if u not in seen:
            seen.add(u)
            unique_urls.append(u)
    image_urls = unique_urls

    if not image_urls:
        return None, "Could not find slide images. SlideShare may have updated their page structure, or the URL might be invalid."

    # Download all images
    images_data = []
    for i, img_url in enumerate(image_urls):
        try:
            img_resp = session.get(img_url, timeout=15)
            img_resp.raise_for_status()
            if len(img_resp.content) > 1000:  # Skip tiny/placeholder images
                images_data.append(img_resp.content)
        except Exception:
            continue

    if not images_data:
        return None, "Failed to download slide images."

    # Convert images to PDF
    filename = f"{slugify(title)}_{uuid.uuid4().hex[:6]}.pdf"
    filepath = os.path.join(DOWNLOAD_DIR, filename)

    try:
        pdf_bytes = img2pdf.convert(images_data)
        with open(filepath, 'wb') as f:
            f.write(pdf_bytes)
    except Exception as e:
        # If img2pdf fails (e.g., unsupported format), try converting with Pillow first
        from PIL import Image
        converted = []
        for data in images_data:
            try:
                img = Image.open(BytesIO(data))
                if img.mode in ('RGBA', 'P', 'LA'):
                    img = img.convert('RGB')
                buf = BytesIO()
                img.save(buf, format='JPEG', quality=95)
                converted.append(buf.getvalue())
            except:
                continue

        if not converted:
            return None, "Failed to process slide images into PDF."

        pdf_bytes = img2pdf.convert(converted)
        with open(filepath, 'wb') as f:
            f.write(pdf_bytes)

    size_mb = os.path.getsize(filepath) / (1024 * 1024)
    return {
        'filename': filename,
        'title': title,
        'pages': len(images_data),
        'size': f"{size_mb:.1f} MB"
    }, None


# ─── Scribd Downloader ───────────────────────────────────────────────

def download_scribd(url):
    """
    Attempt to download a Scribd document.
    Uses the Scribd embed/image extraction approach.
    """
    session = requests.Session()
    session.headers.update(HEADERS)

    # Parse the Scribd URL to get document ID
    match = re.search(r'scribd\.com/(?:doc|document|presentation)/(\d+)', url)
    if not match:
        return None, "Invalid Scribd URL. Expected format: scribd.com/document/XXXXXXX/..."

    doc_id = match.group(1)

    # Try to access the document page
    resp = session.get(url, timeout=20)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, 'html.parser')

    title_tag = soup.find('title')
    title = title_tag.get_text(strip=True) if title_tag else f'Scribd Document {doc_id}'
    title = title.replace(' | PDF', '').replace(' - Scribd', '').strip()

    image_urls = []

    # Strategy 1: Look for page images in the HTML
    # Scribd often uses images like /pages/XXXXX/
    for img in soup.find_all('img'):
        src = img.get('data-src') or img.get('src') or ''
        if 'page' in src.lower() and any(ext in src.lower() for ext in ['.jpg', '.png', '.webp']):
            if src.startswith('//'):
                src = 'https:' + src
            image_urls.append(src)

    # Strategy 2: Look in script/JSON data for image URLs
    if not image_urls:
        for script in soup.find_all('script'):
            text = script.string or ''
            matches = re.findall(r'https?://[^"\'\\]+?/pages/[^"\'\\]+\.(?:jpg|png|webp)', text)
            image_urls.extend(matches)
            # Also look for image_url patterns
            matches2 = re.findall(r'"image_url"\s*:\s*"(https?://[^"]+)"', text)
            image_urls.extend(matches2)

    # Strategy 3: Try the Scribd embed page for images
    if not image_urls:
        embed_url = f"https://www.scribd.com/embeds/{doc_id}/content"
        try:
            embed_resp = session.get(embed_url, timeout=15)
            if embed_resp.ok:
                embed_soup = BeautifulSoup(embed_resp.text, 'html.parser')
                for img in embed_soup.find_all('img'):
                    src = img.get('src') or img.get('data-src') or ''
                    if src and len(src) > 20:
                        if src.startswith('//'):
                            src = 'https:' + src
                        image_urls.append(src)
        except:
            pass

    # Strategy 4: Try known Scribd image URL patterns
    if not image_urls:
        # Scribd uses patterns like:
        # https://imgv2-X-f.scribdassets.com/img/document/DOC_ID/original/PAGE/HASH.jpg
        for page_num in range(1, 51):  # Try first 50 pages
            test_urls = [
                f"https://imgv2-2-f.scribdassets.com/img/document/{doc_id}/original/{page_num}x/{page_num}.jpg",
                f"https://imgv2-1-f.scribdassets.com/img/document/{doc_id}/original/{page_num}x/{page_num}.jpg",
            ]
            for test_url in test_urls:
                try:
                    test_resp = session.head(test_url, timeout=5)
                    if test_resp.status_code == 200:
                        image_urls.append(test_url)
                        break
                except:
                    continue

    # Deduplicate
    seen = set()
    unique_urls = []
    for u in image_urls:
        if u not in seen:
            seen.add(u)
            unique_urls.append(u)
    image_urls = unique_urls

    if not image_urls:
        return None, (
            "Could not extract document pages. Scribd has strong anti-scraping protections. "
            "This document may require a Scribd subscription, or the page structure may have changed. "
            "Try using the browser extension approach or a Scribd subscription for best results."
        )

    # Download images
    images_data = []
    for img_url in image_urls:
        try:
            img_resp = session.get(img_url, timeout=15)
            img_resp.raise_for_status()
            if len(img_resp.content) > 1000:
                images_data.append(img_resp.content)
        except:
            continue

    if not images_data:
        return None, "Found page URLs but failed to download them. Access may be restricted."

    # Convert to PDF
    filename = f"{slugify(title)}_{uuid.uuid4().hex[:6]}.pdf"
    filepath = os.path.join(DOWNLOAD_DIR, filename)

    try:
        from PIL import Image
        converted = []
        for data in images_data:
            try:
                img = Image.open(BytesIO(data))
                if img.mode in ('RGBA', 'P', 'LA'):
                    img = img.convert('RGB')
                buf = BytesIO()
                img.save(buf, format='JPEG', quality=95)
                converted.append(buf.getvalue())
            except:
                continue

        if not converted:
            return None, "Failed to process page images."

        pdf_bytes = img2pdf.convert(converted)
        with open(filepath, 'wb') as f:
            f.write(pdf_bytes)
    except Exception as e:
        return None, f"Failed to create PDF: {str(e)}"

    size_mb = os.path.getsize(filepath) / (1024 * 1024)
    return {
        'filename': filename,
        'title': title,
        'pages': len(images_data),
        'size': f"{size_mb:.1f} MB"
    }, None


# ─── API Routes ───────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/api/download', methods=['POST'])
def api_download():
    data = request.get_json()
    if not data or 'url' not in data:
        return jsonify({'error': 'No URL provided'}), 400

    url = data['url'].strip()
    platform = data.get('platform', 'slideshare')

    if not url.startswith('http'):
        url = 'https://' + url

    try:
        if platform == 'slideshare' or 'slideshare' in url:
            result, error = download_slideshare(url)
        elif platform == 'scribd' or 'scribd' in url:
            result, error = download_scribd(url)
        else:
            return jsonify({'error': 'Unsupported platform'}), 400

        if error:
            return jsonify({'error': error}), 422

        return jsonify({
            'success': True,
            'filename': result['filename'],
            'title': result['title'],
            'pages': result['pages'],
            'size': result['size'],
            'download_url': f"/api/file/{result['filename']}"
        })

    except requests.exceptions.Timeout:
        return jsonify({'error': 'Request timed out. The server took too long to respond. Try again.'}), 504
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'Could not connect to the website. Check your internet connection.'}), 502
    except Exception as e:
        return jsonify({'error': f'An unexpected error occurred: {str(e)}'}), 500


@app.route('/api/file/<filename>')
def download_file(filename):
    # Security: prevent directory traversal
    filename = os.path.basename(filename)
    filepath = os.path.join(DOWNLOAD_DIR, filename)
    if not os.path.exists(filepath):
        return jsonify({'error': 'File not found'}), 404
    return send_file(filepath, as_attachment=True, download_name=filename)


# Cleanup old files (older than 1 hour)
def cleanup_old_files():
    now = time.time()
    for f in os.listdir(DOWNLOAD_DIR):
        path = os.path.join(DOWNLOAD_DIR, f)
        if os.path.isfile(path) and (now - os.path.getmtime(path)) > 3600:
            os.remove(path)


if __name__ == '__main__':
    print("\n🚀 DocGrab server starting...")
    print("📍 Open http://localhost:5000 in your browser\n")
    app.run(host='0.0.0.0', port=5000, debug=True)
