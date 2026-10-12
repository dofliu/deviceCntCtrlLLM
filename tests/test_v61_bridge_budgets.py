"""Evaluate only CLI argument parsing extracted by AST; never load bridge code."""
import argparse
import ast
from contextlib import redirect_stderr
import io
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def parser_only(filename):
    tree = ast.parse((ROOT / filename).read_text(encoding="utf-8"))
    main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main")
    keep = []
    for statement in main.body:
        if isinstance(statement, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "key" for target in statement.targets):
            break
        keep.append(statement)
    # Stop before the first credential lookup: this excludes server and HTTP calls.
    assert len(keep) < len(main.body)
    keep.append(ast.Return(value=ast.Attribute(value=ast.Name(id="args", ctx=ast.Load()), attr="max_calls", ctx=ast.Load())))
    main.body = keep
    fragment = ast.fix_missing_locations(ast.Module(body=[main], type_ignores=[]))
    scope = {"argparse": argparse, "Path": Path, "__file__": str(ROOT / filename), "KEY_NAME": "fake_test_key", "AUTHORIZED_KEY_NAMES": ["fake_test_key"], "authorized_name": lambda value: value == "fake_test_key"}
    exec(compile(fragment, filename, "exec"), scope)
    return scope["main"]


for filename in ("claude_bridge.py", "gemini_bridge.py"):
    parse = parser_only(filename)
    with patch.object(Path, "is_file", return_value=True):
        with patch.object(sys, "argv", [filename]):
            assert parse() == 500
        with patch.object(sys, "argv", [filename, "--max-calls", "500"]):
            assert parse() == 500
        with patch.object(sys, "argv", [filename, "--max-calls", "501"]), redirect_stderr(io.StringIO()):
            try:
                parse()
            except SystemExit as error:
                assert error.code == 2
            else:
                raise AssertionError("501 must be rejected")
    print(filename + ": CLI default 500, 500 accepted, 501 rejected; parse only")
