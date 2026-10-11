# Hospedar o Route Crafter com Docker

Instale Docker Engine e Docker Compose v2 no servidor e copie o projeto, incluindo `Dockerfile`, `docker-compose.yml` e a pasta `docker`. Execute os comandos na raiz do projeto.

## Construir a imagem e usar no Compose

```sh
docker build -t route-crafter:local .
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=100 route-crafter
```

Abra o endereço do seu servidor na porta **8080**. A imagem contém o site e suas bibliotecas, e o Nginx atende na porta interna 8080. Não é necessário instalar Node.js, Java ou Python no servidor para usar o container. O processamento da rota acontece no navegador.

O Compose usa a imagem local `route-crafter:local` criada pelo primeiro comando. Também é possível construir e iniciar de uma vez:

```sh
docker compose up -d --build
```

## Usar outra imagem ou porta

Crie um arquivo `.env` na mesma pasta do Compose com valores como:

```dotenv
ROUTE_CRAFTER_IMAGE=route-crafter:v1
ROUTE_CRAFTER_PORT=8090
```

Depois construa exatamente essa imagem e inicie:

```sh
docker build -t route-crafter:v1 .
docker compose up -d --no-build
```

O site estará na porta 8090 do servidor. Para usar uma imagem de um registro privado ou público, informe o nome completo em `ROUTE_CRAFTER_IMAGE`, faça `docker compose pull` e use `docker compose up -d --no-build`. A imagem deve ter sido criada com este Dockerfile, pois o Compose espera um servidor na porta interna 8080.

## Atualizar e parar

Depois de atualizar os arquivos do projeto:

```sh
docker compose build --pull
docker compose up -d --no-build
```

Para parar e remover os containers desta implantação:

```sh
docker compose down
```

O container roda sem privilégios de root, com o sistema de arquivos somente leitura e `/tmp` temporário para os arquivos internos do Nginx. O health check testa uma resposta HTTP da página inicial. Não há banco de dados nem volumes de dados obrigatórios.

## HTTPS e acesso à rede

Você pode colocar seu proxy reverso habitual na frente da porta publicada e configurar HTTPS e seu domínio nele. Se o proxy estiver no mesmo host, é possível restringir a publicação no Compose para `127.0.0.1:8080:8080`. Se o proxy também estiver em Docker, conecte os serviços a uma rede compartilhada e use `route-crafter:8080` como destino.

O navegador de cada usuário precisa acessar os provedores de mapas e a API Overpass. O container apenas serve os arquivos; ele não faz proxy nem cache dos tiles. Para o fluxo padrão, libere:

| Serviço | Domínios |
| --- | --- |
| Google Maps, Satélite e Híbrido | `mt0.google.com`, `mt1.google.com`, `mt2.google.com`, `mt3.google.com` |
| OpenStreetMap padrão | `a.tile.openstreetmap.org`, `b.tile.openstreetmap.org`, `c.tile.openstreetmap.org` |
| Ruas e áreas | `overpass-api.de` |
| Pesquisa de lugares | `nominatim.openstreetmap.org` |

Camadas alternativas, endpoints Overpass personalizados e coberturas de imagens usam outros domínios. Uma falha nesses serviços externos não implica falha no container. Os tiles Google são acessados diretamente, sem SDK ou chave de API; esses endpoints não são documentados e podem mudar ou deixar de funcionar. O uso continua sujeito aos termos do provedor.

## Editar ruas e passagens

1. Desenhe ou selecione a área e clique em **Fetch Roads**.
2. Clique em **Draw exclusion**, desenhe o polígono e clique no primeiro ponto para finalizar. Os trechos dentro dele ficam proibidos à rota.
3. Clique em **Draw manual passage**, desenhe a passagem e clique no último ponto para finalizar. As extremidades se conectam às ruas próximas dentro da distância configurada em **Snap passage endpoints**. O padrão é 25 metros; use 0 para exigir encaixe exato.
4. Use a barra de edição/exclusão no mapa para modificar os desenhos e clique em **Save**. O status avisa quando há trechos manuais desconectados.
5. Clique em **Generate Route** e depois em **Export GPX**.

Passagens manuais são obrigatórias e podem ser percorridas nos dois sentidos. As exclusões têm prioridade e também recortam essas passagens. Alterar ou apagar desenhos recalcula a malha a partir das ruas originais sem repetir a busca. A rota anterior é descartada para evitar exportar dados antigos.

Se uma exclusão separar a malha em partes, continua valendo a regra do programa de resolver o maior componente conectado. Conecte as partes com uma passagem manual, se houver uma passagem real permitida. Os desenhos duram apenas na sessão atual da página: atualizar a página, usar **Reset** ou mudar o modo de seleção da área os remove.
