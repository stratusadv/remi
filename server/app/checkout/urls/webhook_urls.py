from django.urls import path

from app.checkout.views import webhook_views


app_name = 'webhook'

urlpatterns = [
    path('event/', webhook_views.stripe_event_view, name='event'),
]
