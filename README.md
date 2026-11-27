# PartsPlug

A car-parts marketplace prototype with My Garage, VIN decoding, and camera-based VIN text recognition.

## Website (GitHub Pages)

The root `index.html` is a static site. In repository **Settings → Pages**, choose **Deploy from a branch → main → /(root)**. The URL will be `https://leangut36.github.io/Parts-Plug/` once GitHub Pages finishes publishing.

### How the Garage works

Select **Garage → Add vehicle**. Enter a 17-character VIN and select **Decode & add car**, or take/upload a VIN photo. The photo scanner attempts to recognize the text; **confirm the VIN before decoding**. Confirm the decoded vehicle before saving. Manual entry is also available.

The site uses NHTSA's public VIN decoding API and Tesseract.js for browser OCR. VIN lookup requires internet access. Vehicles, saved parts, and listings are stored **only in that browser**, not shared between users/devices. The photos of demo parts are external reference images. The compatibility filter is keyword-based and does not verify exact fitment.

## Development backend (not connected to the static site)

`server.js` contains an experimental Express + SQLite API for garage, catalog, VIN cache, and listings. Node 20+ is recommended.

```bash
npm install
npm start
```

The server listens on `127.0.0.1:3000` **only**. It uses a placeholder `x-user-id` header as authentication, which is insecure. **Do not expose or deploy it publicly** before replacing that mechanism with verified user authentication, authorization checks, and appropriate input validation. GitHub Pages does not run Node.js or SQLite, and the static frontend does not currently call this backend.

For a real multi-user marketplace, the next step is to design and deploy authenticated storage and connect the frontend to it.
