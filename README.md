# 🛣️ Route Crafter

Route Crafter is a web app to automatically generate the most efficient .gpx route covering every street in an area. Created by me to generate routes to collect my own street-view/360 imagery for [Google Street View, Mapillary, Panoramax etc.](https://wiki.openstreetmap.org/wiki/Street-level_imagery_services)

## Run on your server

The app is static: it needs no Java compilation, npm build, database or server API keys. With Docker and Docker Compose installed, run these commands from the repository root:

```sh
docker build -t route-crafter:local .
docker compose up -d --no-build
docker compose ps
```

The container serves the app on your server's port **8080**, runs as an unprivileged user, and includes an HTTP health check. You can also build and start in one command with `docker compose up -d --build`. To use your own image tag or port:

```sh
ROUTE_CRAFTER_IMAGE=route-crafter:v1 ROUTE_CRAFTER_PORT=8090 docker compose up -d --build
```

See [the complete deployment and usage guide in Portuguese](docs/SELF_HOSTING.pt-BR.md) for updates, custom images, reverse proxies and network requirements.

For local development, run `python3 -m http.server 8000` from this directory. Dependencies are vendored; there is no install step. Geometry tests use Node.js 22+ and the vendored Turf library:

```sh
node --test tests/*.test.mjs
```

An optional browser smoke test covers fetching fixture roads, exclusion polygons, snapping a manual bypass, route generation, GPX export and editing/reset. Install its tooling outside the checkout and run it while the local server is running:

```sh
npm install --prefix /tmp/route-crafter-browser-tools --cache /tmp/route-crafter-npm-cache --no-audit --no-fund playwright@1.58.2
PLAYWRIGHT_MODULE=/tmp/route-crafter-browser-tools/node_modules/playwright node tests/browser-smoke.cjs
```

This test uses system Chromium at `/usr/bin/chromium`; set `CHROMIUM_PATH` if it is installed elsewhere, and `ROUTE_CRAFTER_URL` to test another server. It mocks tiles and Overpass to test application behavior independently of external service availability.

## Google map layers

The map layer selector includes **Google Maps** (streets), **Google Satellite** (imagery) and **Google Hybrid** (imagery with labels and streets). These use direct Google raster tiles without loading the Google Maps SDK or requiring an API key. Google attribution stays visible on the map. Direct tile endpoints are undocumented and may change or become unavailable; their use remains subject to Google's service terms.

## Exclusions and manual passages

After selecting/drawing an area and clicking **Fetch Roads**, use **Draw exclusion** to mark an area where the route must not travel. Finish by clicking the first point. The portions of roads inside the polygon are removed, including roads crossing it without an OSM vertex inside. Roads outside the polygon remain available. Exclusions also apply to manually added passages.

Use **Draw manual passage** to add a missing road or connection. Finish by clicking the last point. The endpoints snap to existing road segments within the chosen distance (25 meters by default), and crossings become shared routing vertices. These passages are bidirectional and mandatory, including with the Windy Rural solver and coverage filtering. Snapping updates the routing geometry; the purple drawing keeps the points you drew so you can adjust it.

Use the map toolbar labeled **Edit exclusions and manual passages** or **Delete exclusions and manual passages**, then **Save**, to change or remove the drawings. Editing reuses the downloaded roads and clears any previous route; click **Generate Route** to recompute and then **Export GPX**. Removing an exclusion restores the original roads. A disconnected-passage message means you must connect its endpoints or increase the snap distance. The solver's existing largest-component behavior still applies, so disconnecting the road network can omit isolated sections.

Edits remain in the current page session and apply again when roads are fetched or uploaded. **Reset**, changing the area mode or reloading the page clears them.

## Search Map
If you know the name of a place and want to quickly jump there, you can use the search map feature. This is not required as part of route generation. This uses the OpenStreetMap Nominatim service.

## Set Starting Location
Set where you want the start of your route to be. It will attempt to snap to the nearest node after road fetching.

## Find Areas
There are different types of areas you can choose. Firstly, you can use OpenStreetMap areas:
* Landuse: Residential/Retail/Commercial/Industrial
* Admin Level 10
* Admin Level 9
* Admin Level 8
* Admin Level 7
* Boundary: Neighborhood
* Boundary: Political
* Boundary: Census
* Place: Suburb
* Place: Quarter
* Place: Postal code
* Place: District
* Place: Subdistrict

Click on multiple areas to generate a single route for a larger area. If the areas selected don't quite connect, you can expand the surrounding area by increasing the buffer.

Are the OpenStreetMap areas unsuitable? There are some additional options you can choose:
* 500m x 500m grid
* 1km x 1km grid
* 1.5km x 1.5km grid
* Draw your own area! (additional buttons will appear under the zoom buttons)

## Fetch Roads
Once you have picked your areas, click 'Fetch Roads',  it will retrieve the OSM ways based on your filters (see below).

## Generate Route
Press 'Generate Route' to send the roads to the ArcRoutingLibrary solver to create the route solution.

Sometimes, you may get a warning that not all of the roads were able to be connected. This can be because of disconnected/inaccessible/one-way roads that cannot reach the starting point.

'Allow navigation past boundary' with Windy Rural can help re-connect roads that have been cut off due to the boundary which gives the option for the solver to use these as optional roads. 

You can choose to continue anyways, where only the largest accessible section will be used to create the route.

## Play Route
Like a media player, you can play, pause, drag to seek, change the speed of a preview of the route.

## Overpass endpoint
Choose your preferred Overpass API endpoint to retrieve areas and roads. The default instance provided by [https://overpass-api.de/](https://overpass-api.de/) can get very busy so you may choose an alternative instance.

**Fetch Roads** requests road geometry with a 60-second Overpass query limit and a 75-second client limit per attempt. If a public global server times out or returns a temporary error (including HTTP 504, 503 or 429), the app tries the other global instances at `overpass.private.coffee` and `overpass.openstreetmap.fr`, starting with your selected instance. The progress message shows which server is in use. Each instance is attempted once; invalid queries and access denials stop immediately. Custom and regional endpoints stay on the selected server and do not switch automatically.

If every attempt fails, try a smaller polygon, reduce **Boundary buffer**, or choose another Overpass endpoint. Partial responses containing an Overpass error are rejected rather than used as complete road data. The browser smoke test includes a simulated HTTP 504 followed by a successful alternate-server response.

## Route Solvers
To be able to find the most efficient route, we use the [Chinese Postman Problem](https://en.wikipedia.org/wiki/Chinese_postman_problem) theory and its variants. There are different solvers to choose from, depending on your needs where some will create a shorter route than others.

| Solver | Oversimplified Description |
|--|--|
| Windy Rural (Benavent) (Default) | Improved version of the Win solver |
| Windy Rural (Win) | Mixed + Can specify roads that are optional |
| Mixed (Yaoyuenyong) | Improved version of the Frederickson solver |
| Mixed (Frederickson)| Single direction for one-way but otherwise bi-directional |
| Undirected | Treats all roads as bi-directional (Even one-way roads) |
| Directed | All sides of a road (i.e. both sides for bi-directional roads) |

## Coverage Overlays and Filter
Hover on the layers menu (or tap on touch screen) to see the option to show Mapillary, Panoramax, KartaView and Mapilio coverage (or change the map layer!). You need to zoom in the map enough to be able to select and view the overlay. If an overlay is enabled and you zoom too far out, the map will turn slightly grey.

Due to limitations with the KartaView API, filtering or skip route sections is not available for KartaView.

### Coverage Filter
You can apply date, image type and User ID filters which will reflect in the map. Note that the User ID/Account ID is the unique ID of the user, not the username. For Mapillary and Mapilio, this is a set of numbers. For Panoramax, this is a UUID.

### Skip route sections with street-level coverage
With Windy Rural, enabling this means you can exclude sections of a road that have already been covered based on your coverage filter, so it is not required to go through the section again. Traversing through already covered sections is still possible if it is more efficient or there is no other way to reach an uncovered road.

| Option | Description|
|-|-|
| Coverage Threshold | How much of the section should already be covered to be excluded from route. |
|Proximity Threshold | How far to search if there is already coverage. |


## Navigation and Route Filter
The navigation filter can be used to exclude OSM ways that you do not want to traverse through. e.g. I do not want to drive on a footway.

The route filter is only available for Windy Rural. This is for OSM ways that have not been filtered out by the navigation filter where you can use this to mark OSM ways as traversable but only if necessary to get to other required ways. e.g. If you are a cyclist and can ride on a footway but do not need to cover footways.

## Export GPX
Once you are happy with the generated route, press 'Export GPX' to save the .gpx file for navigation! 

Unfortunately, most navigation apps are only designed for A to B or point to point navigation which makes it difficult to view the many [overlapping paths](https://github.com/osmandapp/OsmAnd/issues/9975) of an area. So, what are some navigation apps you can use? There is my [modded OsmAnd](https://github.com/seen-one/OsmAnd) or I have also found [Locus Map](https://www.locusmap.app/) can work. I would love to know if there are more.

## Maybe todo list
* ~~Consolidate intersections (previously we had OSMnx that could do it)~~
*  OSM relations turn restrictions
* Local storage remembering settings and location
* Browser location retrieval
* ~~Better U-turn avoidance~~
* Key:oneway:bicycle

## Some Technical Details
Route Crafter uses leaflet.js for the interface and to display the map. All of the data is retrieved from Overpass API. For the route solver algorithms, [ArcRoutingLibrary](https://github.com/Olibear/ArcRoutingLibrary) is used but written in Java. With significant [modifications](https://github.com/seen-one/ArcRoutingLibrary/), TeaVM is used to compile the Java code into JavaScript and run the code directly in-browser. No server-side processing required!

The [previous version](https://github.com/seen-one/Route-Crafter/tree/everystreet) of Route Crafter uses the [everystreet](https://github.com/matejker/everystreet) library. This uses Python with only undirected route support but with somewhat better U-turn avoidance modifications by me. 

Vibe coded using everything. ChatGPT. Perplexity. Cursor. GitHub Copilot. Codex. Google Antigravity.

## Debug Menu
Append [?debug](https://route.crafter.seen.one/?debug) to end of the URL to show the debug menu. After the OSM ways have been fetched, clicking 'Export Largest Component OARLib' will create an .oarlib file suitable for the unmodified ArcRoutingLibrary .jar file (except mode 7 which has a bug). Download [here](https://github.com/Olibear/ArcRoutingLibrary/releases/tag/1.0.1) and use the commands as shown [here](https://github.com/Olibear/ArcRoutingLibrary/blob/master/HOW_TO_USE.txt) to generate the solution. Paste the solution and click 'Apply Solution (Largest Component)' and it will be applied as the solution which can be used to play or download the .gpx route.

## Related
* [Every Street Challenge](http://www.everystreetchallenge.com/) - The original inspiration
* [solipsia/RunEveryStreet](https://github.com/solipsia/RunEveryStreet)
	*  [clementh44/RunEveryStreet](https://github.com/clementh44/RunEveryStreet) (fork)
	* [lejun/RunEveryStreet](https://codeberg.org/lejun/RunEveryStreet) (fork)
* [rkistner/chinese-postman](https://github.com/rkistner/chinese-postman)
* [Wandrer](https://news.wandrer.earth/2026/04/02/chinese-postman-routing.html)
* [Antwerp Postman Optimizer](https://rvanbruggen.github.io/ChinesePostman/)
* [Missing Mapillary GraphHopper Routing](https://github.com/vizsim/missing_mapillary_gh-routing)
	* [Street-level Photo Coverage Routing](https://github.com/atchisson/street_view_routing) (fork)
* Creating a route manually with [BRouter](https://brouter.de/brouter-web/)
