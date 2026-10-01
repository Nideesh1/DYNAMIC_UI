import json

from agentglow.mapper import text_of
from agentglow.otel import _attrs


def test_long_output_keeps_final_message_text():
    answer = "Paris is cooler than Tokyo today."
    meta = {"response_metadata": {"x": "y" * 6000}, "usage": {"input_tokens": 1}}
    out = json.dumps({"messages": [{"type": "human", "content": "Compare Paris and Tokyo. " * 200},
                                   {"type": "ai", "content": answer, **meta}]})
    a = _attrs({"output.value": out})
    assert len(a["output.value"]) < len(out)  # truncated on the wire
    assert a["agentglow.output_text"] == answer
    assert text_of(a["output.value"], 2000) != answer  # (the bug this guards against)


def test_short_output_untouched():
    assert "agentglow.output_text" not in _attrs({"output.value": json.dumps({"content": "hi"})})
