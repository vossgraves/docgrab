#!/bin/bash
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║        🚀 DocGrab - PDF Downloader           ║"
echo "║   SlideShare & Scribd Document Grabber        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "📦 Installing dependencies..."
pip install flask requests beautifulsoup4 Pillow img2pdf --quiet 2>/dev/null
echo "✅ Dependencies ready"
echo ""
echo "🌐 Starting server at: http://localhost:5000"
echo "   Press Ctrl+C to stop"
echo ""
python server.py
