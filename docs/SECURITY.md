`Config.update` behind `PATCH /config` is the only project-config write path; it is an explicit user API request, while automatic config changes must not write into a project.
