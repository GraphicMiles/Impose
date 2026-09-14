import asyncio
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))
os.environ.setdefault("CONTROL_KEY", "test123")

from relay.videos import (  # noqa: E402
    _supported_result, _twitch_target, _youtube_id, _youtube_channel_id,
    _video_subject, _verify_twitch_channel, parse_bing_videos, parse_youtube_feed,
    parse_youtube_search,
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


def test_exact_twitch_channel_is_verified_by_its_page_title():
    class Response:
        status_code = 200
        text = "<title>KaiCenat - Twitch</title>"

    class Client:
        async def get(self, url, **kwargs):
            assert url == "https://www.twitch.tv/kaicenat"
            return Response()

    row = asyncio.run(_verify_twitch_channel(Client(), "Kai Cenat Twitch official channel"))
    assert row["id"] == "kaicenat"

    Response.text = "<title>Twitch</title>"
    assert asyncio.run(_verify_twitch_channel(Client(), "Kai Cenat Twitch official channel")) is None


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


def test_youtube_search_parser_returns_verified_ids_and_channel():
    page = '''<script>var ytInitialData = {"contents":[{"videoRenderer":{
      "videoId":"FMggEmTmQ0U",
      "title":{"runs":[{"text":"ICEKING OCHACHO - NO COMPETITION (OFFICIAL VIDEO)"}]},
      "ownerText":{"runs":[{"text":"ICEKING OCHACHO","navigationEndpoint":{
        "browseEndpoint":{"browseId":"UC2gMbAUTXBQMQYP5dL7uoug"}}}]},
      "publishedTimeText":{"simpleText":"1 day ago"},
      "thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/FMggEmTmQ0U/hq.jpg"}]}
    }},{"videoRenderer":{"videoId":"gTKS8SAwUzE",
      "title":{"simpleText":"Iceking Ochacho old remix"},
      "ownerText":{"runs":[{"text":"Iceking Ochacho"}]}}}]};</script>'''
    rows = parse_youtube_search(page, "No Competition by Iceking Ochacho", 4)
    assert len(rows) == 1
    assert rows[0]["id"] == "FMggEmTmQ0U"
    assert rows[0]["channelId"] == "UC2gMbAUTXBQMQYP5dL7uoug"
    assert rows[0]["channel"] == "ICEKING OCHACHO"


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
