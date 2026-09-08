import json
import shutil

import httpx
import numpy as np
import pytest

from core.artifact_manifest import validate_manifest
from core.embedder import GeminiEmbedder, EmbeddingUnavailable, load_embedder
from core.embedding_cache import CachedEmbedder, SQLiteEmbeddingCache
from core.terrain import energy_grid


def test_artifacts_reject_wrong_provider_and_changed_file(tmp_path):
    for name in ('manifest.json', 'seed_map.json', 'encoder.npz', 'vectorizers.pkl'):
        shutil.copyfile('artifacts/' + name, tmp_path / name)
    assert validate_manifest(tmp_path, 'onnx')['artifact_version'] == 'kotoba-map-v1'
    with pytest.raises(RuntimeError):
        validate_manifest(tmp_path, 'gemini')
    with (tmp_path / 'encoder.npz').open('ab') as handle:
        handle.write(b'changed')
    with pytest.raises(RuntimeError, match='checksum'):
        validate_manifest(tmp_path, 'onnx')


def test_gemini_requires_key(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    with pytest.raises(RuntimeError, match='GEMINI_API_KEY'):
        load_embedder(provider='gemini')


def model_with_response(handler):
    model = GeminiEmbedder('secret-test-key')
    model._http.close()
    model._http = httpx.Client(transport=httpx.MockTransport(handler))
    return model


def test_gemini_header_shape_and_normalization():
    def respond(request):
        assert request.headers['x-goog-api-key'] == 'secret-test-key'
        assert 'secret-test-key' not in str(request.url)
        assert len(json.loads(request.content)['requests']) == 2
        return httpx.Response(200, json={'embeddings': [{'values': [1.] * 384}] * 2})
    result = model_with_response(respond).encode(['first', 'second'])
    assert result.shape == (2, 384)
    np.testing.assert_allclose(np.linalg.norm(result, axis=1), 1, atol=1e-6)


@pytest.mark.parametrize('values', [[1.] * 3, [0.] * 384])
def test_gemini_rejects_invalid_vectors(values):
    model = model_with_response(lambda _: httpx.Response(200, json={'embeddings': [{'values': values}]}))
    with pytest.raises(EmbeddingUnavailable):
        model.encode(['text'])


def test_gemini_long_retry_after_does_not_sleep():
    model = model_with_response(lambda _: httpx.Response(429, headers={'Retry-After': '120'}, text='private provider body'))
    with pytest.raises(EmbeddingUnavailable) as error:
        model.encode(['text'])
    assert 'private' not in str(error.value)


def test_persistent_cache_reuses_first_vector_across_instances(tmp_path):
    class Model:
        calls = 0
        def encode(self, texts, **_):
            self.calls += 1
            return np.ones((len(texts), 384), dtype=np.float32) / np.sqrt(384)
    cache = SQLiteEmbeddingCache(tmp_path / 'cache.sqlite')
    model = Model()
    first = CachedEmbedder(model, cache, {'model': 'v1'}).encode(['same', 'same'])
    second = CachedEmbedder(model, cache, {'model': 'v1'}).encode(['same'])
    assert model.calls == 1
    np.testing.assert_array_equal(first[0], second[0])
    CachedEmbedder(model, cache, {'model': 'v2'}).encode(['same'])
    assert model.calls == 2


def test_grid_adds_each_post_once_and_revision_changes():
    post = {'x': 0., 'y': 0., 'energy': 50.}
    bounds = [-50., -50., 50., 50.]
    one = energy_grid([post], bounds, 3)
    two = energy_grid([post, post], bounds, 3)
    assert one['values'][4] == 50
    assert two['values'][4] == 100
    assert one['revision'] != two['revision']
    assert energy_grid([], bounds, 3)['values'] == [0.] * 9


def test_health_reports_actual_model(client):
    health = client.get('/api/health').json()
    assert health['embedding']['provider'] == 'onnx'
    assert health['artifact_compatible'] is True
    assert client.get('/api/config').json()['map_version'] == health['artifact_version']


def test_post_retry_is_idempotent(fresh_client):
    from conftest import Person, CAMPING_A
    import uuid
    person = Person(fresh_client, 'retry@example.com', 'retry')
    headers = {**person.headers, 'Idempotency-Key': str(uuid.uuid4())}
    first = fresh_client.post('/api/posts', json={'body': CAMPING_A}, headers=headers)
    second = fresh_client.post('/api/posts', json={'body': CAMPING_A}, headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json()['id'] == second.json()['id']
    assert fresh_client.get('/api/health').json()['posts'] == 1
