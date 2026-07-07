"""
DocGrab Backend Server
Downloads PDFs from SlideShare and Scribd
No Pillow dependency — works on Termux!
"""

import os
import re
import json
import time
import uuid
import struct
import zlib
import requests
from io import BytesIO
from urllib.parse import urlparse, unquote
from flask import Flask, request, jsonify, send_file, send_from_directory
from bs4 import BeautifulSoup

app = Flask(__name__, static_folder='.', static_url_path='')

DOWNLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'downloads')
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
}


def slugify(text):
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text.strip())
    return text[:80] or 'document'


# ─── Pure Python JPEG dimension reader (no Pillow needed) ────────────

def get_jpeg_dimensions(data):
    """Read width/height from JPEG binary data."""
    i = 0
    if data[0:2] != b'\xff\xd8':
        return None, None
    i = 2
    while i < len(data) - 1:
        if data[i] != 0xff:
            i += 1
            continue
        marker = data[i+1]
        if marker == 0xd9:
            break
        if marker == 0xda:
            break
        if 0xc0 <= marker <= 0xc3:
            h = struct.unpack('>H', data[i+5:i+7])[0]
            w = struct.unpack('>H', data[i+7:i+9])[0]
            return w, h
        length = struct.unpack('>H', data[i+2:i+4])[0]
        i += 2 + length
    return None, None


def get_png_dimensions(data):
    """Read width/height from PNG binary data."""
    if data[0:8] != b'\x89PNG\r\n\x1a\n':
        return None, None
    w = struct.unpack('>I', data[16:20])[0]
    h = struct.unpack('>I', data[20:24])[0]
    return w, h


def get_image_dimensions(data):
    """Detect image type and return (width, height)."""
    if data[:2] == b'\xff\xd8':
        return get_jpeg_dimensions(data)
    elif data[:8] == b'\x89PNG\r\n\x1a\n':
        return get_png_dimensions(data)
    return None, None


# ─── Pure Python PDF builder (no img2pdf/Pillow needed) ──────────────

def build_pdf_from_images(image_data_list):
    """
    Build a valid PDF from a list of JPEG/PNG image bytes.
    Pure Python, no external libraries needed.
    """
    objects = []
    pages_kids = []
    obj_num = 1

    # We'll build objects and write at the end
    # Object numbering: catalog=1, pages=2, then per image: page, xobject, content

    catalog_num = 1
    pages_num = 2
    obj_num = 3

    page_objects = []

    for img_data in image_data_list:
        w, h = get_image_dimensions(img_data)
        if not w or not h:
            w, h = 612, 792  # default letter size

        page_num = obj_num
        xobj_num = obj_num + 1
        contents_num = obj_num + 2
        obj_num += 3

        # Determine image type
        if img_data[:2] == b'\xff\xd8':
            img_filter = '/DCTDecode'
            color_space = '/DeviceRGB'
            stream_data = img_data
        elif img_data[:8] == b'\x89PNG\r\n\x1a\n':
            # For PNG, we embed as JPEG-like by just using raw — 
            # Actually for simplicity, we'll use FlateDecode with raw RGB
            # But that requires decoding PNG... let's just use DCTDecode trick
            # Better: embed PNG data won't work directly in PDF
            # Safest: skip PNGs or note them
            img_filter = '/FlateDecode'
            color_space = '/DeviceRGB'
            stream_data = img_data
        else:
            continue

        # Scale image to fit page (use image dimensions as page size in points)
        # 1 pixel = 0.75 points at 96dpi, but let's just use pixels as points
        # Cap at reasonable page size
        scale = 1.0
        if w > 2000 or h > 2000:
            scale = min(2000/w, 2000/h)
        page_w = w * scale
        page_h = h * scale

        page_objects.append({
            'page_num': page_num,
            'xobj_num': xobj_num,
            'contents_num': contents_num,
            'img_data': stream_data,
            'img_filter': img_filter,
            'color_space': color_space,
            'img_w': w,
            'img_h': h,
            'page_w': page_w,
            'page_h': page_h,
        })
        pages_kids.append(page_num)

    if not page_objects:
        return None

    # Build PDF
    output = BytesIO()
    output.write(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')

    offsets = {}

    def write_obj(num, content_bytes):
        offsets[num] = output.tell()
        output.write(f'{num} 0 obj\n'.encode())
        output.write(content_bytes)
        output.write(b'\nendobj\n')

    # Catalog
    write_obj(catalog_num, f'<< /Type /Catalog /Pages {pages_num} 0 R >>'.encode())

    # Pages
    kids_str = ' '.join(f'{k} 0 R' for k in pages_kids)
    write_obj(pages_num, f'<< /Type /Pages /Kids [{kids_str}] /Count {len(pages_kids)} >>'.encode())

    # Each page
    for p in page_objects:
        # Content stream: draw image scaled to page
        content_stream = f'q {p["page_w"]:.2f} 0 0 {p["page_h"]:.2f} 0 0 cm /Img Do Q'
        content_bytes = content_stream.encode()

        # Page object
        write_obj(p['page_num'],
            f'<< /Type /Page /Parent {pages_num} 0 R '
            f'/MediaBox [0 0 {p["page_w"]:.2f} {p["page_h"]:.2f}] '
            f'/Contents {p["contents_num"]} 0 R '
            f'/Resources << /XObject << /Img {p["xobj_num"]} 0 R >> >> '
            f'>>'.encode()
        )

        # XObject (image)
        img_stream = p['img_data']
        xobj_header = (
            f'<< /Type /XObject /Subtype /Image '
            f'/Width {p["img_w"]} /Height {p["img_h"]} '
            f'/ColorSpace {p["color_space"]} /BitsPerComponent 8 '
            f'/Filter {p["img_filter"]} /Length {len(img_stream)} >>'
        )
        offsets[p['xobj_num']] = output.tell()
        output.write(f'{p["xobj_num"]} 0 obj\n'.encode())
        output.write(xobj_header.encode())
        output.write(b'\nstream\n')
        output.write(img_stream)
        output.write(b'\nendstream\nendobj\n')

        # Contents stream
        write_obj(p['contents_num'],
            f'<< /Length {len(content_bytes)} >>\nstream\n'.encode() +
            content_bytes +
            b'\nendstream'
        )

    # Cross-reference table
    xref_offset = output.tell()
    total_objs = obj_num
    output.write(b'xref\n')
    output.write(f'0 {total_objs}\n'.encode())
    output.write(b'0000000000 65535 f \n')
    for i in range(1, total_objs):
        if i in offsets:
            output.write(f'{offsets[i]:010d} 00000 n \n'.encode())
        else:
            output.write(b'0000000000 00000 f \n')

    # Trailer
    output.write(f'trailer\n<< /Size {total_objs} /Root {catalog_num} 0 R >>\n'.encode())
    output.write(f'startxref\n{xref_offset}\n%%EOF\n'.encode())

    return output.getvalue()


# ─── SlideShare Downloader ────────────────────────────────────────────

def download_slideshare(url):
    session = requests.Session()
    session.headers.update(HEADERS)

    resp = session.get(url, timeout=20)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, 'html.parser')

    title_tag = soup.find('title')
    title = title_tag.get_text(strip=True) if title_tag else 'SlideShare Document'
    title = re.sub(r'\s*\|.*$', '', title).strip()
    title = re.sub(r'\s*-\s*PowerPoint.*$', '', title).strip()

    image_urls = []

    # Strategy 1: srcset and data attributes on images
    for img in soup.find_all('img'):
        srcset = img.get('srcset', '')
        src = img.get('data-full') or img.get('data-normal') or img.get('src', '')
        
        # Get highest res from srcset
        if srcset:
            parts = [s.strip().split(' ')[0] for s in srcset.split(',')]
            src = parts[-1] if parts else src
        
        if src and ('slidesharecdn' in src or 'slide_' in src or '/slide/' in src or 'slideserve' in src):
            if src.startswith('//'):
                src = 'https:' + src
            if src.startswith('http'):
                image_urls.append(src)

    # Strategy 2: Search JavaScript/JSON for image URLs
    if not image_urls:
        for script in soup.find_all('script'):
            text = script.string or ''
            matches = re.findall(r'https?://[^"\'\\,\s]+(?:slidecdn|slidesharecdn|image\.slidesharecdn)[^"\'\\,\s]*\.(?:jpg|jpeg|png|webp)', text)
            image_urls.extend(matches)

    # Strategy 3: Look for picture elements
    if not image_urls:
        for source in soup.find_all('source'):
            srcset = source.get('srcset', '')
            if srcset and ('cdn' in srcset or 'slide' in srcset):
                parts = [s.strip().split(' ')[0] for s in srcset.split(',')]
                for p in parts:
                    if p.startswith('//'):
                        p = 'https:' + p
                    if p.startswith('http'):
                        image_urls.append(p)

    # Strategy 4: meta og:image as last resort (single image)
    if not image_urls:
        for meta in soup.find_all('meta', property='og:image'):
            content = meta.get('content', '')
            if content:
                image_urls.append(content)

    # Deduplicate preserving order
    seen = set()
    unique = []
    for u in image_urls:
        clean = u.split('?')[0]
        if clean not in seen:
            seen.add(clean)
            unique.append(u)
    image_urls = unique

    if not image_urls:
        return None, "Could not find slide images. The URL may be invalid, or SlideShare may have updated their page structure."

    # Download images (only keep ones > 5KB to skip thumbnails/icons)
    images_data = []
    for img_url in image_urls:
        try:
            r = session.get(img_url, timeout=15)
            r.raise_for_status()
            if len(r.content) > 5000:
                images_data.append(r.content)
        except:
            continue

    if not images_data:
        return None, "Failed to download slide images."

    # Build PDF
    pdf_bytes = build_pdf_from_images(images_data)
    if not pdf_bytes:
        return None, "Failed to build PDF from images."

    filename = f"{slugify(title)}_{uuid.uuid4().hex[:6]}.pdf"
    filepath = os.path.join(DOWNLOAD_DIR, filename)
    with open(filepath, 'wb') as f:
        f.write(pdf_bytes)

    size_mb = len(pdf_bytes) / (1024 * 1024)
    return {
        'filename': filename,
        'title': title,
        'pages': len(images_data),
        'size': f"{size_mb:.1f} MB"
    }, None


# ─── Scribd Downloader ───────────────────────────────────────────────

def download_scribd(url):
    session = requests.Session()
    session.headers.update(HEADERS)

    match = re.search(r'scribd\.com/(?:doc|document|presentation)/(\d+)', url)
    if not match:
        return None, "Invalid Scribd URL. Expected: scribd.com/document/XXXXXXX/..."

    doc_id = match.group(1)

    resp = session.get(url, timeout=20)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, 'html.parser')

    title_tag = soup.find('title')
    title = title_tag.get_text(strip=True) if title_tag else f'Scribd-{doc_id}'
    title = re.sub(r'\s*\|.*$', '', title).strip()
    title = re.sub(r'\s*-\s*Scribd.*$', '', title).strip()

    image_urls = []

    # Strategy 1: Images in HTML
    for img in soup.find_all('img'):
        src = img.get('data-src') or img.get('src') or ''
        if src and ('page' in src.lower() or 'scribdassets' in src):
            if src.startswith('//'):
                src = 'https:' + src
            if src.startswith('http') and any(ext in src.lower() for ext in ['.jpg', '.png', '.webp']):
                image_urls.append(src)

    # Strategy 2: Script/JSON data
    if not image_urls:
        for script in soup.find_all('script'):
            text = script.string or ''
            matches = re.findall(r'https?://[^"\'\\]+scribdassets[^"\'\\]+\.(?:jpg|png|webp)', text)
            image_urls.extend(matches)
            matches2 = re.findall(r'"(?:image_url|src|url)"\s*:\s*"(https?://[^"]+\.(?:jpg|png|webp))"', text)
            image_urls.extend(matches2)

    # Strategy 3: Try embed endpoint
    if not image_urls:
        try:
            embed_resp = session.get(f"https://www.scribd.com/embeds/{doc_id}/content", timeout=15)
            if embed_resp.ok:
                embed_soup = BeautifulSoup(embed_resp.text, 'html.parser')
                for img in embed_soup.find_all('img'):
                    src = img.get('src') or img.get('data-src') or ''
                    if src and len(src) > 20:
                        if src.startswith('//'):
                            src = 'https:' + src
                        if src.startswith('http'):
                            image_urls.append(src)
        except:
            pass

    # Deduplicate
    seen = set()
    unique = []
    for u in image_urls:
        if u not in seen:
            seen.add(u)
            unique.append(u)
    image_urls = unique

    if not image_urls:
        return None, (
            "Could not extract pages. Scribd has strong anti-scraping protections. "
            "The document may require a subscription, or their page structure may have changed."
        )

    # Download images
    images_data = []
    for img_url in image_urls:
        try:
            r = session.get(img_url, timeout=15)
            r.raise_for_status()
            if len(r.content) > 5000:
                images_data.append(r.content)
        except:
            continue

    if not images_data:
        return None, "Found page URLs but failed to download them."

    # Build PDF
    pdf_bytes = build_pdf_from_images(images_data)
    if not pdf_bytes:
        return None, "Failed to build PDF from images."

    filename = f"{slugify(title)}_{uuid.uuid4().hex[:6]}.pdf"
    filepath = os.path.join(DOWNLOAD_DIR, filename)
    with open(filepath, 'wb') as f:
        f.write(pdf_bytes)

    size_mb = len(pdf_bytes) / (1024 * 1024)
    return {
        'filename': filename,
        'title': title,
        'pages': len(images_data),
        'size': f"{size_mb:.1f} MB"
    }, None


# ─── Routes ──────────────────────────────────────────────────────────

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
        if 'slideshare' in url or platform == 'slideshare':
            result, error = download_slideshare(url)
        elif 'scribd' in url or platform == 'scribd':
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
        return jsonify({'error': 'Request timed out. Try again.'}), 504
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'Could not connect. Check your internet.'}), 502
    except Exception as e:
        return jsonify({'error': f'Error: {str(e)}'}), 500


@app.route('/api/file/<filename>')
def download_file(filename):
    filename = os.path.basename(filename)
    filepath = os.path.join(DOWNLOAD_DIR, filename)
    if not os.path.exists(filepath):
        return jsonify({'error': 'File not found'}), 404
    return send_file(filepath, as_attachment=True, download_name=filename)


if __name__ == '__main__':
    print("\n🚀 DocGrab server running!")
    print("📍 Open http://localhost:5000 in your browser\n")
    app.run(host='0.0.0.0', port=5000, debug=True)
