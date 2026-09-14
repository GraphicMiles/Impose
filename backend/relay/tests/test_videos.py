import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))
os.environ.setdefault("CONTROL_KEY", "test123")

from relay.videos import (  # noqa: E402
    _supported_result, _twitch_target, _youtube_id, _youtube_channel_id,
    _video_subject, parse_bing_videos, parse_youtube_feed,
)


def test_youtube_url_shapes_are_normalized():
    assert _youtube_id("https://youtu.be/gTKS8SAwUzE?t=3") == "gTKS8SAwUzE"
    assert _youtube_id("https://www.youtube.com/shorts/gTKS8SAwUzE") == "gTKS8SAwUzE"
    assert _youtube_id("javascript:alert(1)") == ""
    row = _supported_result("https://youtube.com/watch?v=gTKS8SAwUzE&x=1", "Latest")
    assert row["url"] == "https://www.youtube.com/watch?v=gTKS8SAwUzE"
    assert row["kind"] == "youtube-video"
    assert _youtube_channel_id("https://youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA/videos") == "UCX6OQ3DkcsbYNE6H8uQQuVA"
    assert _video_subject("Watch MrBeast's most recent YouTube upload") == "MrBeast"
    assert _video_subject("Find any currently available live Twitch streams right now") == ""


def test_twitch_targets_are_bounded():
    assert _twitch_target("https://www.twitch.tv/twitchdev") == ("twitch-channel", "twitchdev")
    assert _twitch_target("https://twitch.tv/videos/12345") == ("twitch-video", "12345")
    assert _twitch_target("https://twitch.tv/clip/Fancy_Clip-1") == ("twitch-clip", "Fancy_Clip-1")
    assert _twitch_target("https://twitch.tv/payments") is None
    assert _twitch_target("https://evil.test/twitchdev") is None


def test_bing_parser_keeps_supported_relevant_results_only():
    page = '''
    <a href="/videos/riverview/relatedvideo?churl=https%3A%2F%2Fwww.youtube.com%2Fchannel%2FUCX6OQ3DkcsbYNE6H8uQQuVA">
      <div ourl="https://www.youtube.com/watch?v=gTKS8SAwUzE">
        <img data-src-hq="https://thumb.test/mrbeast.jpg" alt="MrBeast latest challenge">YouTube MrBeast
      </div>
    </a>
    <div ourl="https://evil.test/watch"><img alt="MrBeast fake"></div>
    <div ourl="javascript:alert(1)"><img alt="MrBeast bad"></div>
    '''
    rows = parse_bing_videos(page, "MrBeast latest video", 6)
    assert len(rows) == 1
    assert rows[0]["id"] == "gTKS8SAwUzE"
    assert rows[0]["channelId"] == "UCX6OQ3DkcsbYNE6H8uQQuVA"
    assert rows[0]["thumb"] == "https://thumb.test/mrbeast.jpg"


def test_feed_parser_returns_real_video_metadata():
    feed = b'''<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom"
          xmlns:yt="http://www.youtube.com/xml/schemas/2015"
          xmlns:media="http://search.yahoo.com/mrss/">
      <entry><yt:videoId>gTKS8SAwUzE</yt:videoId><title>Newest upload</title>
      <published>2026-09-05T16:00:01+00:00</published>
      <media:group><media:thumbnail url="https://thumb.test/new.jpg"/></media:group></entry>
    </feed>'''
    rows = parse_youtube_feed(feed)
    assert rows[0]["title"] == "Newest upload"
    assert rows[0]["publishedAt"].startswith("2026-09-05")
    assert rows[0]["thumb"] == "https://thumb.test/new.jpg"
