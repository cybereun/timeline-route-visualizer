import os
import sys

# 프로젝트 루트 경로 추가
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from server import TimelineRequestHandler

# Vercel Serverless Function 진입점
handler = TimelineRequestHandler
app = TimelineRequestHandler
