# 構成図の生成

全体構成の図（[architecture.png](architecture.png)）は、[architecture.py](architecture.py)から、[diagrams](https://diagrams.mingrammer.com/)
（AWSの公式アーキテクチャアイコンを同梱したPythonのライブラリ）とGraphvizで生成する。構成を変えたら、`architecture.py`を直して生成し直し、
生成した画像も一緒にコミットする。図の中の文字の正本は、[設計書§2](../design/architecture.md#2-全体構成)の表である。

シーケンス図などのほかの図は、各文書の中にMermaidで書いている。

## 準備（Ubuntuの場合）

```sh
sudo apt install -y graphviz libgvplugin-neato-layout8 fonts-noto-cjk python3-venv
python3 -m venv .venv-diagrams
.venv-diagrams/bin/pip install -r docs/diagrams/requirements.txt
```

日本語のラベルには、フォント「Noto Sans CJK JP」を使う。入っていないと、文字が化ける。
線を直線で引くため、各ノードの位置を座標で決め、Graphvizのneatoで配置する。Ubuntuでは、neatoは`libgvplugin-neato-layout8`に分かれている。
ノードを足すときは、ほかのノードやラベルと重ならない座標を選ぶ。

## 生成

リポジトリのルートで実行する。

```sh
.venv-diagrams/bin/python docs/diagrams/architecture.py
```
